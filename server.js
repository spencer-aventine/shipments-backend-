import express from "express";
import axios from "axios";
import FormData from "form-data";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ====== ENV (you'll set these in Render) ======
const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;             // HubSpot project app token (Static Auth)
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "47987553";   // e.g., 47987553
const RM_BASE           = process.env.RM_BASE || "https://api.royalmail.net";
const RM_CLIENT_ID      = process.env.RM_CLIENT_ID;
const RM_CLIENT_SECRET  = process.env.RM_CLIENT_SECRET;
const RM_USERNAME       = process.env.RM_USERNAME;
const RM_PASSWORD       = process.env.RM_PASSWORD;
const INBOUND_SECRET    = process.env.INBOUND_SECRET || "";      // optional; used for /tracking/sync protection

// ====== health ======
app.get("/", (_, res) => res.type("text").send("Shipments backend OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ====== helper: optional secret check for cron ======
function checkSecret(req, res, next) {
  if (!INBOUND_SECRET) return next();                // no secret configured
  const got = req.header("x-inbound-secret");
  if (got === INBOUND_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ====== Create Label (supports GET from your HubSpot card) ======
app.all("/labels/create", async (req, res) => {
  try {
    const listingId = req.query.listingId || req.body?.listingId;
    if (!listingId) return res.status(400).json({ ok:false, error:"missing listingId" });

    // 1) Read the Shipment (Listings) record from HubSpot
    const props = [
      "shipment_id","order_number","service_type","service_code","package_type",
      "weight_grams","length_mm","width_mm","height_mm",
      "sender_name","sender_line1","sender_city","sender_postcode","sender_country_code",
      "recipient_name","recipient_line1","recipient_city","recipient_postcode","recipient_country_code",
      "label_format","label_size","rmg_shipment_number","tracking_number","label_url"
    ];
    const hsUrl = `https://api.hubapi.com/crm/v3/objects/listings/${listingId}?properties=${props.join(",")}`;
    const hs = await axios.get(hsUrl, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    const p = hs.data.properties || {};

    // Idempotency: if already has a shipment created, don't create again
    if (p.rmg_shipment_number) {
      return res.json({ ok:true, message:"Shipment already created", trackingNumber: p.tracking_number, labelUrl: p.label_url });
    }

    // 2) Royal Mail auth
    const tok = await axios.post(`${RM_BASE}/shipping/v2/token`, {
      client_id: RM_CLIENT_ID, client_secret: RM_CLIENT_SECRET, username: RM_USERNAME, password: RM_PASSWORD
    });
    const rmToken = tok.data?.access_token;

    // 3) Create Royal Mail shipment
    const serviceCode = p.service_code || mapServiceType(p.service_type);
    const body = {
      serviceCode,
      shipmentDate: new Date().toISOString().slice(0,10),
      sender: {
        name: p.sender_name,
        address: { addressLine1: p.sender_line1, postcode: p.sender_postcode, countryCode: p.sender_country_code || "GB" }
      },
      recipient: {
        name: p.recipient_name,
        address: { addressLine1: p.recipient_line1, postcode: p.recipient_postcode, countryCode: p.recipient_country_code || "GB" }
      },
      package: {
        weightInGrams: Number(p.weight_grams) || 0,
        dimensions: { lengthMM:+p.length_mm||0, widthMM:+p.width_mm||0, heightMM:+p.height_mm||0 }
      },
      references: { customerReference: p.order_number || p.shipment_id || listingId }
    };
    const created = await axios.post(`${RM_BASE}/shipping/v2/domestic`, body, {
      headers: { Authorization: `Bearer ${rmToken}`, "Content-Type": "application/json" }
    });
    const shipmentNumber = created.data?.shipmentNumber;
    const trackingNumber = created.data?.trackingNumber;

    // 4) Generate label (PDF)
    const label = await axios.put(`${RM_BASE}/shipping/v2/${shipmentNumber}/label`, null, {
      headers: { Authorization: `Bearer ${rmToken}` }, responseType: "arraybuffer"
    });
    const labelBuffer = Buffer.from(label.data);
    const filename = `${p.order_number || p.shipment_id || shipmentNumber}.pdf`;

    // 5) Upload the label to HubSpot Files (public URL, not indexed)
    const labelUrl = await uploadToHubSpotFiles(labelBuffer, filename, "application/pdf");

    // 6) Patch the Shipment with results
    await axios.patch(`https://api.hubapi.com/crm/v3/objects/listings/${listingId}`, {
      properties: {
        rmg_shipment_number: shipmentNumber,
        tracking_number: trackingNumber,
        tracking_url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
        label_url: labelUrl,
        shipment_status: "Label Printed"
      }
    }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});

    // Nice UX: redirect back to the Shipment in HubSpot if user opened this in a tab
    const recordUrl = HUBSPOT_PORTAL_ID
      ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/LISTINGS/${listingId}`
      : "";
    return res.status(200).send(
      recordUrl
        ? `<p>Label created. <a href="${recordUrl}" target="_self">Return to Shipment</a></p><script>window.location="${recordUrl}"</script>`
        : { ok: true, shipmentNumber, trackingNumber, labelUrl }
    );

  } catch (e) {
    console.error("[/labels/create] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok:false, error: e?.response?.data || e.message });
  }
});

// ====== Tracking sync (cron calls this) ======
app.post("/tracking/sync", checkSecret, async (_req, res) => {
  try {
    const searchBody = {
      filterGroups: [{ filters: [{ propertyName: "shipment_status", operator: "NOT_IN", values: ["Delivered","Cancelled"] }]}],
      properties: ["tracking_number","shipment_status"], limit: 100
    };
    const { data } = await axios.post("https://api.hubapi.com/crm/v3/objects/listings/search", searchBody, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    const results = data?.results || [];
    let updated = 0;

    for (const rec of results) {
      const id = rec.id;
      const tracking = rec.properties?.tracking_number;
      if (!tracking) continue;

      const t = await rmGetTracking(tracking); // TODO: implement using RM Tracking API
      if (!t) continue;

      const update = mapTrackingToProperties(t);
      if (Object.keys(update).length) {
        await axios.patch(`https://api.hubapi.com/crm/v3/objects/listings/${id}`, { properties: update }, {
          headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
        });
        updated++;
      }
    }
    return res.json({ ok: true, scanned: results.length, updated });

  } catch (e) {
    console.error("[/tracking/sync] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok:false, error: e?.response?.data || e.message });
  }
});

// ====== helpers ======
function mapServiceType(t) { return ({ "Tracked 24":"TR24", "Tracked 48":"TR48" }[t] || t); }

async function uploadToHubSpotFiles(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });
  form.append("options", JSON.stringify({ access: "PUBLIC_NOT_INDEXABLE" }));
  const { data } = await axios.post("https://api.hubapi.com/files/v3/files", form, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, ...form.getHeaders() },
    maxContentLength: Infinity, maxBodyLength: Infinity
  });
  return data?.url || data?.full_url || "";
}

// TODO: replace with Royal Mail Tracking API call; return something like:
// { status: "In Transit", lastEvent: { code, description, location, time }, eta: "YYYY-MM-DD" }
async function rmGetTracking(trackingNumber) { return null; }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shipments backend listening on :${PORT}`));
