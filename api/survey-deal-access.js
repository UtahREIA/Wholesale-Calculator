// /api/survey-deal-access.js
//
// Webhook endpoint called by a GHL workflow when a survey is submitted.
// Upserts the contact into the Airtable "Deal Access Requests" table.
//
// Required env vars (set in Vercel):
//   AIRTABLE_API_KEY_DEAL_ACCESS   — Airtable personal access token
//   AIRTABLE_BASE_ID_DEAL_ACCESS   — Base ID (appXXXXXXXXXXXXXX)
//   AIRTABLE_TABLE_DEAL_ACCESS     — Table name (default: "Deal Access Requests")
//   GHL_WEBHOOK_SECRET             — Optional: shared secret to validate GHL calls

// Survey names that should be IGNORED (do not add to deal-access).
// Keep this list lowercase for case-insensitive comparison.
const EXCLUDED_SURVEYS = [
  "rehab estimator readiness survey (old)",
];

// Maps survey name keywords → Calculator Type value written to Airtable.
// Matched case-insensitively against the surveyName field.
// Order matters: first match wins.
const SURVEY_TYPE_MAP = [
  { keywords: ["brrrr"],                          type: "BRRRR" },
  { keywords: ["fix", "flip"],                    type: "Fix & Flip" },
  { keywords: ["rehab estimator", "rehab"],       type: "Rehab Estimator" },
  { keywords: ["short-term", "short term"],       type: "Short Term" },
  { keywords: ["rental", "rent"],                 type: "Rentals" },
  { keywords: ["wholesaler", "wholesale"],        type: "Wholesale" },
  { keywords: ["your path to success", "path"],  type: "General" },
];

function resolveCalculatorType(surveyName) {
  const lower = (surveyName || "").toLowerCase();
  for (const { keywords, type } of SURVEY_TYPE_MAP) {
    if (keywords.every((kw) => lower.includes(kw))) return type;
  }
  return "General";
}

export default async function handler(req, res) {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-ghl-secret");

  if (req.method === "OPTIONS") return res.status(200).send("OK");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ---- Optional webhook secret validation ----
    const WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET;
    if (WEBHOOK_SECRET) {
      const incoming = req.headers["x-ghl-secret"] || req.headers["x-webhook-secret"];
      if (incoming !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    // ---- Parse body ----
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const {
      name,
      email,
      phone,
      surveyName,        // Name of the GHL survey — set this in your GHL workflow action
      contactId,         // GHL contact ID — available as {{contact.id}} in GHL workflow
      notes,             // Optional extra notes from the survey/workflow
    } = body;

    // ---- Validate survey name ----
    if (!surveyName) {
      return res.status(400).json({ error: "surveyName is required" });
    }

    const surveyLower = surveyName.trim().toLowerCase();
    if (EXCLUDED_SURVEYS.includes(surveyLower)) {
      // Silently skip excluded surveys — return 200 so GHL doesn't retry
      console.log(`Skipping excluded survey: "${surveyName}"`);
      return res.status(200).json({ ok: true, skipped: true, reason: "excluded survey" });
    }

    // ---- Require at least one identifier ----
    const normalizedPhone = normalizePhone(phone);
    if (!email && !normalizedPhone && !contactId) {
      return res.status(400).json({ error: "At least one of email, phone, or contactId is required" });
    }

    // ---- Env vars ----
    const AIRTABLE_KEY   = process.env.AIRTABLE_API_KEY_DEAL_ACCESS;
    const AIRTABLE_BASE  = process.env.AIRTABLE_BASE_ID_DEAL_ACCESS;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_DEAL_ACCESS || "Deal Access Requests";

    if (!AIRTABLE_KEY || !AIRTABLE_BASE) {
      return res.status(500).json({
        error: "Missing Airtable env vars",
        missing: {
          AIRTABLE_API_KEY_DEAL_ACCESS: !AIRTABLE_KEY,
          AIRTABLE_BASE_ID_DEAL_ACCESS: !AIRTABLE_BASE,
        },
      });
    }

    const tableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
    const airtableHeaders = {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      "Content-Type": "application/json",
    };

    const today = new Date().toISOString().split("T")[0];

    // ---- Check for existing record (dedup by phone or email) ----
    let existingRecordId = null;
    let existingFields   = {};

    if (normalizedPhone || email) {
      const conditions = [];
      if (normalizedPhone) {
        // Normalize stored phone the same way as the check-phone endpoints
        conditions.push(
          `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number}, '(', ''), ')', ''), '-', ''), ' ', ''), 10) = '${normalizedPhone}'`
        );
      }
      if (email) {
        conditions.push(`{Email} = '${email.replace(/'/g, "\\'")}'`);
      }

      const filter = conditions.length === 1
        ? conditions[0]
        : `OR(${conditions.join(", ")})`;

      const searchUrl = new URL(tableUrl);
      searchUrl.searchParams.set("filterByFormula", filter);
      searchUrl.searchParams.set("maxRecords", "1");

      const searchResp = await fetch(searchUrl.toString(), {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      });
      const searchData = await searchResp.json();

      if (searchData.records && searchData.records.length > 0) {
        existingRecordId = searchData.records[0].id;
        existingFields   = searchData.records[0].fields || {};
      }
    }

    // ---- Build the Airtable fields to write ----
    const capitalizedName = capitalizeName(name);

    const fields = {
      ...(capitalizedName                    ? { "Name":            capitalizedName }      : {}),
      ...(email                              ? { "Email":           email.toLowerCase() }  : {}),
      ...(normalizedPhone                    ? { "Phone Number":    normalizedPhone }       : {}),
      ...(contactId                          ? { "GHL Contact ID":  contactId }             : {}),
      "Survey Name":     surveyName,
      "Calculator Type": resolveCalculatorType(surveyName),
      "Request Date":    today,
      "Access Status":   existingFields["Access Status"] || "Pending", // never overwrite a manual decision
      ...(notes ? { "Notes": notes } : {}),
    };

    let result;

    if (existingRecordId) {
      // PATCH existing record — update survey name / date, keep status
      const patchResp = await fetch(`${tableUrl}/${existingRecordId}`, {
        method: "PATCH",
        headers: airtableHeaders,
        body: JSON.stringify({ fields }),
      });
      result = await patchResp.json();
      if (!patchResp.ok) {
        console.error("Airtable PATCH failed", result);
        return res.status(502).json({ error: "Airtable update failed", details: result });
      }
    } else {
      // POST new record
      const postResp = await fetch(tableUrl, {
        method: "POST",
        headers: airtableHeaders,
        body: JSON.stringify({ fields }),
      });
      result = await postResp.json();
      if (!postResp.ok) {
        console.error("Airtable POST failed", result);
        return res.status(502).json({ error: "Airtable create failed", details: result });
      }
    }

    const recordId = result.id;
    console.log(`Deal access ${existingRecordId ? "updated" : "created"} — Airtable record ${recordId}, survey: "${surveyName}"`);

    return res.status(200).json({
      ok: true,
      recordId,
      action: existingRecordId ? "updated" : "created",
      survey: surveyName,
    });

  } catch (err) {
    console.error("survey-deal-access error:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

// ---- Helpers ----

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function capitalizeName(name) {
  if (!name) return "";
  return name
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
