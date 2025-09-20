import express from "express";
import axios from "axios";
import FormData from "form-data";
import PDFDocument from "pdfkit";

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ===================== ENV (set these in Render) ===================== */
const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;                 // REQUIRED
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "47987553";       // e.g., 47987553
const RM_BASE           = process.env.RM_BASE || "https://api.royalmail.net";
const RM_CLIENT_ID      = process.env.RM_CLIENT_ID || "";
const RM_CLIENT_SECRET  = process.env.RM_CLIENT_SECRET || "";
const RM_USERNAME       = process.env.RM_USERNAME || "";
const RM_PASSWORD       = process.env.RM_PASSWORD || "";
const INBOUND_SECRET    = process.env.INBOUND_SECRET || "";          // optional: protects /tracking/sync

// MOCK controls (work without Royal Mail access)
const MOCK_MODE             = (process.env.MOCK_MODE || "false").toLowerCase() === "true";
const MOCK_TRACKING_STATUS  = process.env.MOCK_TRACKING_STATUS || ""; // e.g., "In Transit"

// Optional sender defaults (used if not stored on the Shipment)
const SENDER_NAME     = process.env.SENDER_NAME     || "Your Company";
const SENDER_LINE1    = process.env.SENDER_LINE1    || "1 Example Way";
const SENDER_CITY     = process.env.SENDER_CITY     || "London";
const SENDER_POSTCODE = process.env.SENDER_POSTCODE || "W1A 1AA";
const SENDER_COUNTRY  = process.env.SENDER_COUNTRY  || "GB";

/* ===================== Utilities ===================== */
function hsHeaders() {
  return { Authorization: `Bearer ${HUBSPOT_TOKEN}` };
}

function requireEnv() {
  if (!HUBSPOT_TOKEN) {
    throw new Error("HUBSPOT_TOKEN is required");
  }
}

/* Secret check for cron endpoint */
function checkSecret(req, res, next) {
  if (!INBOUND_SECRET) return next();
  const got = req.header("x-inbound-secret");
  if (got === INBOUND_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

/* Health */
app.get("/", (_, res) => res.type("text").send("Shipments backend OK"));
app.get("/health", (_, res) => res.json({ ok: true, mock: MOCK_MODE }));

/* ===================== HubSpot Helpers ===================== */

async function uploadToHubSpotFiles(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });
  form.append("options", JSON.stringify({ access: "PUBLIC_NOT_INDEXABLE" }));
  // optional: form.append("folderPath", "/RoyalMail/Labels");
  const { data } = await axios.post("https://api.hubapi.com/files/v3/files", form, {
    headers: { ...hsHeaders(), ...form.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return data?.url || data?.full_url || "";
}

async function patchHubSpotObject(objectType, id, properties) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${id}`;
  await axios.patch(url, { properties }, { headers: hsHeaders() });
}

async function getAssociations(fromType, id, toType) {
  const url = `https://api.hubapi.com/crm/v4/objects/${fromType}/${id}/associations/${toType}`;
  const { data } = await axios.get(url, { headers: hsHeaders() });
  // returns array of { toObjectId, associationTypes: [...] }
  return (data?.results || []).map(r => r.toObjectId);
}

/* ===================== Royal Mail Wrappers (MOCK-aware) ===================== */

async function rmCreateShipment({ serviceCode, sender, recipient, reference }) {
  if (MOCK_MODE) {
    return {
      shipmentNumber: `MOCK-${Date.now()}`,
      trackingNumber: `RM${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`,
      rmToken: undefined
    };
  }
  // Real token
  const tok = await axios.post(`${RM_BASE}/shipping/v2/token`, {
    client_id: RM_CLIENT_ID,
    client_secret: RM_CLIENT_SECRET,
    username: RM_USERNAME,
    password: RM_PASSWORD
  });
  const rmToken = tok.data?.access_token;

  // Real create
  const body = {
    serviceCode,
    shipmentDate: new Date().toISOString().slice(0, 10),
    sender,
    recipient,
    // Your business rules: Letter + 100g always
    package: { weightInGrams: 100, dimensions: { lengthMM: 0, widthMM: 0, heightMM: 0 } },
    references: { customerReference: reference }
  };
  const created = await axios.post(`${RM_BASE}/shipping/v2/domestic`, body, {
    headers: { Authorization: `Bearer ${rmToken}`, "Content-Type": "application/json" }
  });
  return {
    shipmentNumber: created.data?.shipmentNumber,
    trackingNumber: created.data?.trackingNumber,
    rmToken
  };
}

async function rmGetLabelPDF({ shipmentNumber, rmToken, recipient }) {
  if (MOCK_MODE) {
    return makeMockLabelPDF({
      trackingNumber: shipmentNumber?.replace("MOCK-", "RM") || "RM0000000000",
      recipientName: recipient?.name,
      recipientPostcode: recipient?.address?.postcode
    });
  }
  const label = await axios.put(`${RM_BASE}/shipping/v2/${shipmentNumber}/label`, null, {
    headers: { Authorization: `Bearer ${rmToken}` },
    responseType: "arraybuffer"
  });
  return Buffer.from(label.data);
}

// TODO: implement real tracking. In MOCK, returns fixed status if provided.
async function rmGetTracking(trackingNumber) {
  if (MOCK_MODE) {
    if (!MOCK_TRACKING_STATUS) return null; // only change if you set a fake status
    const now = new Date().toISOString();
    return {
      status: MOCK_TRACKING_STATUS, // e.g., "In Transit"
      lastEvent: { code: "MOCK", description: "Mock tracking update", location: "Test Hub", time: now },
      eta: ""
    };
  }
  // Real: call RM tracking API; return object like above
  return null;
}

/* ===================== Mock Label PDF ===================== */

async function makeMockLabelPDF({ trackingNumber, recipientName, recipientPostcode }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(20).text("ROYAL MAIL — MOCK LABEL", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Tracking: ${trackingNumber}`);
    doc.text(`Recipient: ${recipientName || "N/A"}`);
    doc.text(`Postcode: ${recipientPostcode || "N/A"}`);
    doc.moveDown();
    doc.text("This is a mock label generated for testing without Royal Mail credentials.");
    doc.rect(36, 300, 523, 200).stroke();
    doc.end();
  });
}

/* ===================== Mapping tracking → HS properties ===================== */

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

/* ===================== ROUTES ===================== */

/**
 * Create label from CONTACT (recommended).
 * - Reads contact address
 * - Creates Shipment (LISTINGS)
 * - Creates RM shipment (TR48, Letter, 100g) + label
 * - Uploads PDF to HubSpot Files
 * - Patches Shipment + Contact properties
 */
app.all("/labels/create-from-contact", async (req, res) => {
  try {
    requireEnv();
    const contactId = req.query.contactId || req.body?.contactId;
    if (!contactId) return res.status(400).json({ ok: false, error: "missing contactId" });

    // 1) Contact
    const props = "firstname,lastname,address,city,zip,country,abc_create_label_now,abc_label_created,abc_tracking_number,abc_shipment_status";
    const c = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${props}`,
      { headers: hsHeaders() }
    );
    const cp = c.data.properties || {};
    const recipient = {
      name: `${cp.firstname || ""} ${cp.lastname || ""}`.trim() || "Recipient",
      line1: cp.address,
      city: cp.city,
      postcode: cp.zip,
      country: (cp.country || "GB").toUpperCase()
    };
    if (!recipient.line1 || !recipient.postcode) {
      return res.status(400).send("Contact is missing address line1 or postcode.");
    }

    // 2) Flip trigger property so workflows can enroll
    await patchHubSpotObject("contacts", contactId, { abc_create_label_now: "true" });

    // 3) Create Shipment (LISTINGS)
    const shipmentProps = {
      shipment_id: `CT-${contactId}-${Date.now()}`,
      order_number: `CT-${contactId}`,
      // Sender defaults (override if you store per-record)
      sender_name: SENDER_NAME,
      sender_line1: SENDER_LINE1,
      sender_city: SENDER_CITY,
      sender_postcode: SENDER_POSTCODE,
      sender_country_code: SENDER_COUNTRY,
      // Recipient
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
      { headers: hsHeaders() }
    );
    const listingId = ls.data.id;

    // 4) Associate Shipment ↔ Contact
    await axios.post(
      "https://api.hubapi.com/crm/v4/associations/listings/contacts/batch/create",
      { inputs: [{ from: { id: listingId }, to: { id: contactId }, type: "listing_to_contact" }] },
      { headers: hsHeaders() }
    );

    // 5) Create RM shipment (always TR48, Letter, 100g) + label
    const { shipmentNumber, trackingNumber, rmToken } = await rmCreateShipment({
      serviceCode: "TR48",
      sender: {
        name: SENDER_NAME,
        address: { addressLine1: SENDER_LINE1, postcode: SENDER_POSTCODE, countryCode: SENDER_COUNTRY }
      },
      recipient: {
        name: recipient.name,
        address: { addressLine1: recipient.line1, postcode: recipient.postcode, countryCode: recipient.country }
      },
      reference: `CT-${contactId}`
    });

    const labelBuffer = await rmGetLabelPDF({
      shipmentNumber,
      rmToken,
      recipient: { name: recipient.name, address: { postcode: recipient.postcode } }
    });
    const labelUrl = await uploadToHubSpotFiles(labelBuffer, `CT-${contactId}.pdf`, "application/pdf");

    // 6) Patch Shipment
    await patchHubSpotObject("listings", listingId, {
      rmg_shipment_number: shipmentNumber,
      tracking_number: trackingNumber,
      tracking_url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
      label_url: labelUrl,
      shipment_status: "Label Printed"
    });

    // 7) Patch Contact (for workflow triggers/visibility)
    await patchHubSpotObject("contacts", contactId, {
      abc_label_created: "true",
      abc_label_created_at: new Date().toISOString(),
      abc_tracking_number: trackingNumber,
      abc_shipment_status: "Label Printed"
    });

    // 8) Redirect back to Contact
    const contactUrl = HUBSPOT_PORTAL_ID
      ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`
      : "";
    return res
      .status(200)
      .send(contactUrl
        ? `<p>Label created. <a href="${contactUrl}" target="_self">Back to Contact</a></p><script>window.location="${contactUrl}"</script>`
        : { ok: true, listingId, trackingNumber, labelUrl });

  } catch (e) {
    console.error("[/labels/create-from-contact] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/**
 * Create label from SHIPMENT (Listings) (optional legacy button).
 * - Idempotent: if rmg_shipment_number exists, returns early.
 */
app.all("/labels/create", async (req, res) => {
  try {
    requireEnv();
    const listingId = req.query.listingId || req.body?.listingId;
    if (!listingId) return res.status(400).json({ ok: false, error: "missing listingId" });

    // Fetch Shipment
    const props = [
      "shipment_id","order_number","shipment_status",
      "sender_name","sender_line1","sender_city","sender_postcode","sender_country_code",
      "recipient_name","recipient_line1","recipient_city","recipient_postcode","recipient_country_code",
      "rmg_shipment_number","tracking_number","label_url"
    ];
    const hsUrl = `https://api.hubapi.com/crm/v3/objects/listings/${listingId}?properties=${props.join(",")}`;
    const hs = await axios.get(hsUrl, { headers: hsHeaders() });
    const p = hs.data.properties || {};

    if (p.rmg_shipment_number) {
      const recordUrl = HUBSPOT_PORTAL_ID
        ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/LISTINGS/${listingId}`
        : "";
      return res
        .status(200)
        .send(recordUrl
          ? `<p>Shipment already created. <a href="${recordUrl}" target="_self">Back to Shipment</a></p><script>window.location="${recordUrl}"</script>`
          : { ok: true, message: "already created", trackingNumber: p.tracking_number, labelUrl: p.label_url });
    }

    const sender = {
      name: p.sender_name || SENDER_NAME,
      address: {
        addressLine1: p.sender_line1 || SENDER_LINE1,
        postcode: p.sender_postcode || SENDER_POSTCODE,
        countryCode: p.sender_country_code || SENDER_COUNTRY
      }
    };
    const recipient = {
      name: p.recipient_name,
      address: {
        addressLine1: p.recipient_line1,
        postcode: p.recipient_postcode,
        countryCode: p.recipient_country_code || "GB"
      }
    };

    const { shipmentNumber, trackingNumber, rmToken } = await rmCreateShipment({
      serviceCode: "TR48",
      sender,
      recipient,
      reference: p.order_number || p.shipment_id || listingId
    });

    const labelBuffer = await rmGetLabelPDF({ shipmentNumber, rmToken, recipient });
    const filename = `${p.order_number || p.shipment_id || shipmentNumber}.pdf`;
    const labelUrl = await uploadToHubSpotFiles(labelBuffer, filename, "application/pdf");

    await patchHubSpotObject("listings", listingId, {
      rmg_shipment_number: shipmentNumber,
      tracking_number: trackingNumber,
      tracking_url: `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
      label_url: labelUrl,
      shipment_status: "Label Printed"
    });

    const recordUrl = HUBSPOT_PORTAL_ID
      ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/LISTINGS/${listingId}`
      : "";
    return res
      .status(200)
      .send(recordUrl
        ? `<p>Label created. <a href="${recordUrl}" target="_self">Return to Shipment</a></p><script>window.location="${recordUrl}"</script>`
        : { ok: true, trackingNumber, labelUrl });

  } catch (e) {
    console.error("[/labels/create] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/**
 * Tracking sync (Scheduler/cron calls this).
 * - Scans Shipments not in Delivered/Cancelled
 * - Updates Shipment status & last event
 * - Also mirrors status to associated Contacts (for Contact workflows)
 */
app.post("/tracking/sync", checkSecret, async (_req, res) => {
  try {
    requireEnv();
    const searchBody = {
      filterGroups: [{ filters: [{ propertyName: "shipment_status", operator: "NOT_IN", values: ["Delivered","Cancelled"] }]}],
      properties: ["tracking_number","shipment_status"],
      limit: 100
    };
    const { data } = await axios.post("https://api.hubapi.com/crm/v3/objects/listings/search", searchBody, {
      headers: hsHeaders()
    });
    const results = data?.results || [];
    let updated = 0;

    for (const rec of results) {
      const id = rec.id;
      const tracking = rec.properties?.tracking_number;
      if (!tracking) continue;

      const t = await rmGetTracking(tracking);
      if (!t) continue;

      const update = mapTrackingToProperties(t);
      if (!Object.keys(update).length) continue;

      // Update Shipment
      await patchHubSpotObject("listings", id, update);

      // Also mirror status to associated Contacts
      const contactIds = await getAssociations("listings", id, "contacts");
      if (contactIds.length) {
        const contactUpdate = {};
        if (update.shipment_status) contactUpdate.abc_shipment_status = update.shipment_status;
        if (Object.keys(contactUpdate).length) {
          await Promise.all(contactIds.map(cid => patchHubSpotObject("contacts", cid, contactUpdate)));
        }
      }

      updated++;
    }

    return res.json({ ok: true, scanned: results.length, updated });

  } catch (e) {
    console.error("[/tracking/sync] error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* ===================== Start ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shipments backend listening on :${PORT} (mock=${MOCK_MODE})`));
