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
// Create label from a Contact: builds a Shipment, creates RM label, updates both
app.all("/labels/create-from-contact", async (req, res) => {
  try {
    const contactId = req.query.contactId || req.body?.contactId;
    if (!contactId) return res.status(400).json({ ok:false, error:"missing contactId" });

    // 1) Read contact fields (adjust if your contact stores different field names)
    const c = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,address,city,zip,country,abc_create_label_now,abc_label_created,abc_tracking_number,abc_shipment_status`,
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    const cp = c.data.properties || {};
    const recipient = {
      name: `${cp.firstname || ""} ${cp.lastname || ""}`.trim() || "Recipient",
      line1: cp.address,
      city: cp.city,
      postcode: cp.zip,
      country: (cp.country || "GB").toUpperCase()
    };

    // Early validation
    if (!recipient.line1 || !recipient.postcode) {
      return res.status(400).send("Contact is missing address line1 or postcode.");
    }

    // 2) Mark "clicked" + clear/create fields on Contact (so Workflows can trigger)
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: { abc_create_label_now: "true" } },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    // 3) Create the Shipment (Listings) record
    const shipmentProps = {
      shipment_id: `CT-${contactId}-${Date.now()}`,
      order_number: `CT-${contactId}`,
      // Sender defaults come from env or record-level if you added them
      sender_name: process.env.SENDER_NAME || "Your Company",
      sender_line1: process.env.SENDER_LINE1 || "1 Example Way",
      sender_city: process.env.SENDER_CITY || "London",
      sender_postcode: process.env.SENDER_POSTCODE || "W1A 1AA",
      sender_country_code: process.env.SENDER_COUNTRY || "GB",
      // Recipient from contact
      recipient_name: recipient.name,
      recipient_line1: recipient.line1,
      recipient_city: recipient.city,
      recipient_postcode: recipient.postcode,
      recipient_country_code: recipient.country,
      // Initial status
      shipment_status: "Created"
    };
    const ls = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/listings",
      { properties: shipmentProps },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    const listingId = ls.data.id;

    // 4) Associate Shipment ⇄ Contact
    await axios.post(
      "https://api.hubapi.com/crm/v4/associations/listings/contacts/batch/create",
      { inputs: [{ from: { id: listingId }, to: { id: contactId }, type: "listing_to_contact" }] },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    // 5) Create RM shipment (Tracked 48, Letter, 100g) and label
    const tok = await axios.post(`${RM_BASE}/shipping/v2/token`, {
      client_id: RM_CLIENT_ID, client_secret: RM_CLIENT_SECRET, username: RM_USERNAME, password: RM_PASSWORD
    });
    const rmToken = tok.data?.access_token;

    const createBody = {
      serviceCode: "TR48",
      shipmentDate: new Date().toISOString().slice(0,10),
      sender: {
        name: process.env.SENDER_NAME || "Your Company",
        address: {
          addressLine1: process.env.SENDER_LINE1 || "1 Example Way",
          postcode: process.env.SENDER_POSTCODE || "W1A 1AA",
          countryCode: process.env.SENDER_COUNTRY || "GB"
        }
      },
      recipient: {
        name: recipient.name,
        address: {
          addressLine1: recipient.line1,
          postcode: recipient.postcode,
          countryCode: recipient.country
        }
      },
      package: { weightInGrams: 100, dimensions: { lengthMM: 0, widthMM: 0, heightMM: 0 } },
      references: { customerReference: `CT-${contactId}` }
    };

    const created = await axios.post(`${RM_BASE}/shipping/v2/domestic`, createBody, {
      headers: { Authorization: `Bearer ${rmToken}`, "Content-Type": "application/json" }
    });
    const shipmentNumber = created.data?.shipmentNumber;
    const trackingNumber = created.data?.trackingNumber;

    const label = await axios.put(`${RM_BASE}/shipping/v2/${shipmentNumber}/label`, null, {
      headers: { Authorization: `Bearer ${rmToken}` }, responseType: "arraybuffer"
    });
    const labelUrl = await uploadToHubSpotFiles(Buffer.from(label.data), `CT-${contactId}.pdf`, "application/pdf");

    // 6) Patch the Shipment + Contact
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/listings/${listingId}`,
      { properties: {
          rmg_shipment_number: shipmentNumber,
          tracking_number: trackingNumber,
          tracking_url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
          label_url: labelUrl,
          shipment_status: "Label Printed"
      }},
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: {
          abc_label_created: "true",
          abc_label_created_at: new Date().toISOString(),
          abc_tracking_number: trackingNumber,
          abc_shipment_status: "Label Printed"
      }},
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    // 7) Redirect back to the Contact (or the Shipment if you prefer)
    const contactUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
    return res
      .status(200)
      .send(`<p>Label created. <a href="${contactUrl}" target="_self">Back to Contact</a></p>
             <script>window.location="${contactUrl}"</script>`);

  } catch (e) {
    console.error("[/labels/create-from-contact] error:", e?.response?.data || e.message);
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
