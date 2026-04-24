export default async function handler(req, res) {
  // ---- CORS (always) ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).send("OK");
  }

  // Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    // ---- Parse body safely ----
    // Vercel/Next usually gives req.body as object already.
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});

    let phone = body.phone;
    if (!phone) {
      return res.status(400).json({ valid: false, error: "No phone provided" });
    }

    phone = String(phone).replace(/\D/g, "");
    const last10 = phone.slice(-10);
    if (last10.length < 10) {
      return res.status(400).json({ valid: false, error: "Invalid phone number" });
    }

    // ---- Env vars ----
    const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY_WHOLESALE;
    const AIRTABLE_ID = process.env.AIRTABLE_BASE_ID_WHOLESALE;
    const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME_WHOLESALE || "Verifications";

    if (!AIRTABLE_KEY || !AIRTABLE_ID) {
      return res.status(500).json({
        valid: false,
        error: "Missing Airtable environment variables",
        missing: {
          AIRTABLE_API_KEY_WHOLESALE: !AIRTABLE_KEY,
          AIRTABLE_BASE_ID_WHOLESALE: !AIRTABLE_ID,
        }
      });
    }

    const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

    // Airtable formulas
    const normalizePhoneFormula =
      `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number}, '(', ''), ')', ''), '-', ''), ' ', ''), 10)`;

    const filterActive =
      `AND(${normalizePhoneFormula} = '${last10}', {Approval Status} = 'Approved', {Member Status} = 'Active')`;

    const filterAny =
      `${normalizePhoneFormula} = '${last10}'`;

    // helper to call Airtable
    async function airtableGet(filterByFormula) {
      const url = new URL(AIRTABLE_URL);
      url.searchParams.set("filterByFormula", filterByFormula);

      const r = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${AIRTABLE_KEY}`,
        },
      });

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!r.ok) {
        const msg = data?.error?.message || `Airtable error ${r.status}`;
        throw new Error(msg);
      }
      return data;
    }

    async function airtablePatch(recordId, fields) {
      const r = await fetch(`${AIRTABLE_URL}/${recordId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${AIRTABLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });

      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!r.ok) {
        const msg = data?.error?.message || `Airtable patch error ${r.status}`;
        throw new Error(msg);
      }
      return data;
    }

    const isoToday = body.localDate || new Date().toISOString().split("T")[0];

    // 1) Active member check
    let data = await airtableGet(filterActive);
    let records = data.records || [];
    if (records.length > 0) {
      const record = records[0];
      return res.json({
        valid: true,
        name: record.fields?.Name || "",
        status: "Active",
        trial: false
      });
    }

    // 2) Any contact check
    data = await airtableGet(filterAny);
    records = data.records || [];

    if (records.length === 0) {
      return res.json({ valid: false });
    }

    const record = records[0];
    const recordId = record.id;
    const fields = record.fields || {};
    const name = fields.Name || "";
    const firstAccess = fields["First Access Date"];
    const memberStatus = String(fields["Member Status"] || "").toLowerCase();

    // If active, unlimited
    if (memberStatus === "active") {
      return res.json({ valid: true, name, status: "Active", trial: false });
    }

    // Trial logic
    const today = new Date();
    let trialStart = firstAccess;
    let trialDaysLeft = 0;
    let trialExpired = false;

    if (!firstAccess) {
      await airtablePatch(recordId, { "First Access Date": isoToday });
      trialStart = isoToday;
      trialDaysLeft = 30;
    } else {
      const start = new Date(firstAccess);
      const diff = Math.floor((today - start) / (1000 * 60 * 60 * 24));
      trialDaysLeft = Math.max(0, 30 - diff);
      trialExpired = diff > 30;
    }

    if (!trialExpired) {
      return res.json({
        valid: true,
        name,
        status: "Trial",
        trial: true,
        trialDaysLeft
      });
    }

    return res.json({
      valid: false,
      name,
      status: "Trial Expired",
      trial: true,
      trialDaysLeft: 0
    });

  } catch (err) {
    // Keep response JSON always
    return res.status(500).json({
      valid: false,
      error: err?.message || "Server error"
    });
  }
}
