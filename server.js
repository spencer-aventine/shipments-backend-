import express from "express";
import axios from "axios";
import FormData from "form-data";

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ====== ENV: set these in Render (no hardcoding) ====== */
const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;           // <— HS Project App token (Static Auth)
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "47987553"; // <— your portal (pre-set)
const RM_BASE           = process.env.RM_BASE || "https://api.royalmail.net";
const RM_CLIENT_ID      = process.env.RM_CLIENT_ID;
const RM_CLIENT_SECRET  = process.env.RM_CLIENT_SECRET;
const RM_USERNAME       = process.env.RM_USERNAME;
const RM_PASSWORD       = process.env.RM_PASSWORD;
const INBOUND_SECRET    = process.env.INBOUND_SECRET || "";    // optional: protects /tracking/sync

/* ====== OPTIONAL: default sender if not stored per record ====== */
const SENDER_NAME       = process.env.SENDER_NAME       || "Your Company";
const SENDER_LINE1      = process.env.SENDER_LINE1      || "1 Example Way";
const SENDER_CITY       = process.env.SENDER_CITY       || "London";
const SENDER_POSTCODE   = process.env.SENDER_POSTCODE   || "W1A 1AA";
const SENDER_COUNTRY    = process.env.SENDER_COUNTRY    || "GB";

/* ====== simple health ====== */
app.get("/", (_, res) => res.type("text").send("Shipments backend OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* ====== protect cron if you set INBOUND_SECRET ====== */
function checkSecret(req, res, next) {
  if (!INBOUND_SECRET) return next();
  const got = req.header("x-inbound-secret");
  if (got === INBOUND_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* ====== CREATE LABEL: called by your HubSpot card ====== */
/* Uses your business rules: Tracked 48 + Letter + 100g */
app.all("/labels/create", async (req, res) => {
  try {
    const listingId = req.query.listingId || req.body?.listingId;
    if (!listingId) return res.status(400).json({ ok:false, error:"missing listingId" });

    // 1) Fetch Shipment (Listings) from HubSpot
    const props = [
      // core
      "shipment_id","order_number","shipment_status",
      // addresses (we’ll default sender in env)
      "sender_name","sender_line1","sender_city","sender_postcode","sender_country_code",
      "recipient_name","recipient_line1","recipient_city","recipient_postcode","recipient_country_code",
      // return + tracking
      "rmg_shipment_number","tracking_number","label_url"
    ];
    const hsUrl = `https://api.hubapi.com/crm/v3/objects/listings/${listingId}?properties=${props.join(",")}`;
    const hs = await axios.get(hsUrl, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    const p = hs.data.properties || {};

    // Idempotency: if we already created, don't create again
    if (p.rmg_shipment_number) {
      const recordUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/LISTINGS/${listingId}`;
      return res
        .status(200)
        .send(`<p>Shipment already created. <a href="${recordUrl}" target="_self">Back to Shipment</a></p>
               <script>window.location="${recordUrl}"</script>`);
    }

    // 2) Royal Mail auth
    const tok = await axios.post(`${RM_BASE}/shipping/v2/token`, {
      client_id: RM_CLIENT_ID, client_secret: RM_CLIENT_SECRET, username: RM_USERNAME, password: RM_PASSWORD
    });
    const rmToken = tok.data?.access_token;

    // 3) Create RM shipment — fixed service & weight by your rules
    const createBody = {
      serviceCode: "TR48",                                      // Always Tracked 48
      shipmentDate: new Date().toISOString().slice(0,10),
      sender: {
        name: p.sender_name || SENDER_NAME,
        address: {
          addressLine1: p.sender_line1 || SENDER_LINE1,
          postcode: p.sender_postcode || SENDER_POSTCODE,
          countryCode: p.sender_country_code || SENDER_COUNTRY
        }
      },
      recipient: {
        name: p.recipient_name,
        address: {
          addressLine1: p.recipient_line1,
          postcode: p.recipient_postcode,
          countryCode: p.recipient_country_code || "GB"
        }
      },
      package: {
        // Always Letter, 100g (dimensions not required for letters)
        weightInGrams: 100,
        dimensions: { lengthMM: 0, widthMM: 0, heightMM: 0 }
      },
      references: {
        customerReference: p.order_number || p.shipment_id || listingId
      }
    };

    const created = await axios.post(`${RM_BASE}/shipping/v2/domestic`, createBody, {
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

    // 5) Upload to HubSpot Files (public, non-indexed)
    const labelUrl = await uploadToHubSpotFiles(labelBuffer, filename, "application/pdf");

    // 6) Patch Shipment back in HubSpot
    await axios.patch(`https://api.hubapi.com/crm/v3/objects/listings/${listingId}`, {
      properties: {
        rmg_shipment_number: shipmentNumber,
        tracking_number: trackingNumber,
        tracking_url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
        label_url: labelUrl,
        shipment_status: "Label Printed"
      }
    }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});

    // Redirect back to the Shipment record for a smooth UX
    const recordUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/LISTINGS/${listingId}`;
    return res
      .status(200)
      .send(`<p>Label created. <a href="${recordUrl}" target="_self">Return to Shipment</a></p>
             <script>window.location="${recordUrl}"</script>`);

  } catch (e) {
    console.error("[/labels/create] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok:false, error: e?.response?.data || e.message });
  }
});

/* ====== TRACKING SYNC: called by GitHub Actions on a schedule ====== */
app.post("/tracking/sync", checkSecret, async (_req, res) => {
  try {
    const searchBody = {
      filterGroups: [{ filters: [{ propertyName: "shipment_status", operator: "NOT_IN", values: ["Delivered","Cancelled"] }]}],
      properties: ["tracking_number","shipment_status"],
      limit: 100
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

      // TODO: implement with RM Tracking API
      const t = await rmGetTracking(tracking);
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

/* ====== Helpers ====== */
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

// TODO: wire to RM Tracking API; return { status, lastEvent:{ code, description, location, time }, eta }
async function rmGetTracking(_trackingNumber) { return null; }

function mapTrackingToProperties(t) {
  const out = {};
  if (t.status) out.shipment_status = t.status;
  if (t.lastEvent) {
    out.last_event_code = t.lastEvent.code;
    out.last_event_description = t.lastEvent.description;
    out.last_event_location = t.lastEvent.location;
    out.last_event_time = t.lastEvent.time; // ISO 8601
  }
  if (t.eta) out.expected_delivery_date = t.eta;
  if (t.status === "Delivered" && t.lastEvent?.time) out.delivered_datetime = t.lastEvent.time;
  return out;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shipments backend listening on :${PORT}`));
