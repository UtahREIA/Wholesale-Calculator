// /api/airtable-to-ghl-wholesale.js

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { phone, email, name, calculator = "Wholesale", firstAccessAt } = req.body || {};

    const normalizedPhone = normalizePhone(phone);

    if (!email && !normalizedPhone) {
      return res.status(400).json({ error: "Missing email or phone" });
    }

    // --- ENV VARS (set in Vercel) ---
    // Use GHL_API_KEY for GoHighLevel API authentication
    const TOKEN = process.env.GHL_API_KEY;
    const LOCATION_ID = process.env.GHL_LOCATION_ID;
    // CF_CALC_USER_ID is the custom field ID for the "Access To Calculators" field in GHL
    // You can find this in GHL by inspecting the custom field in the contact record or via the API
    const CF_CALC_USER_ID = process.env.CF_CALC_USER_ID;

    const CF_CALC_NAME_ID = process.env.CF_CALC_NAME_ID; // optional
    const CF_FIRST_ACCESS_ID = process.env.CF_FIRST_ACCESS_ID; // optional

    if (!TOKEN || !LOCATION_ID || !CF_CALC_USER_ID) {
      return res.status(500).json({
        error: "Missing env vars",
        missing: {
          GHL_TOKEN: !TOKEN,
          GHL_LOCATION_LOCATION_ID: !LOCATION_ID,
          CF_CALC_USER_ID: !CF_CALC_USER_ID
        }
      });
    }

    const baseUrl = "https://services.leadconnectorhq.com";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      Version: "2021-07-28"
    };

    // 1) Upsert contact (creates or updates)
    const upsertPayload = {
      locationId: LOCATION_ID,
      ...(email ? { email } : {}),
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      ...(name ? { name } : {})
    };

    const upsertResp = await fetch(`${baseUrl}/contacts/upsert`, {
      method: "POST",
      headers,
      body: JSON.stringify(upsertPayload)
    });

    const upsertText = await upsertResp.text();
    let upsertData;
    try {
      upsertData = JSON.parse(upsertText);
    } catch {
      upsertData = { raw: upsertText };
    }

    if (!upsertResp.ok) {
      console.error("GHL upsert failed", { status: upsertResp.status, upsertData });
      return res.status(502).json({ error: "GHL upsert failed", details: upsertData });
    }

    const contactId =
      upsertData?.contact?.id ||
      upsertData?.contact?._id ||
      upsertData?.id;

    if (!contactId) {
      console.error("Could not determine contactId", { upsertData });
      return res.status(502).json({ error: "Could not determine contactId", details: upsertData });
    }

    // 2) Update custom fields
    const customFields = [{ id: CF_CALC_USER_ID, value: true }];

    if (CF_CALC_NAME_ID) {
      customFields.push({ id: CF_CALC_NAME_ID, value: String(calculator) });
    }

    if (CF_FIRST_ACCESS_ID) {
      customFields.push({
        id: CF_FIRST_ACCESS_ID,
        value: firstAccessAt || new Date().toISOString()
      });
    }

    const updateResp = await fetch(`${baseUrl}/contacts/${contactId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ locationId: LOCATION_ID, customFields })
    });

    const updateText = await updateResp.text();
    let updateData;
    try {
      updateData = JSON.parse(updateText);
    } catch {
      updateData = { raw: updateText };
    }

    if (!updateResp.ok) {
      console.error("GHL update failed", { status: updateResp.status, updateData });
      return res.status(502).json({ error: "GHL update failed", details: updateData });
    }

    return res.status(200).json({ ok: true, contactId });
  } catch (err) {
    console.error("airtable-to-ghl-wholesale error:", err);
    if (err?.response) {
      try {
        const errorText = await err.response.text();
        console.error("GHL API error response:", errorText);
      } catch {}
    }
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}

// Keep last 10 digits (US-style). If you want E.164 later, we can upgrade this.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
