// /api/survey-deal-access.js
//
// Webhook endpoint called by a GHL workflow when a survey is submitted.
// Upserts the contact into the Airtable "Deal Access Requests" table with:
//   - Auto-approval for active GHL members
//   - Multi-interest tracking (never overwrites previous interests)
//   - Priority scoring based on membership, engagement, and recency
//   - Admin notification via a configurable GHL webhook
//
// Required env vars (set in Vercel):
//   AIRTABLE_API_KEY_DEAL_ACCESS   — Airtable personal access token
//   AIRTABLE_BASE_ID_DEAL_ACCESS   — Base ID (appXXXXXXXXXXXXXX)
//   AIRTABLE_TABLE_DEAL_ACCESS     — Table name (default: "Deal Access Requests")
//
// Optional env vars:
//   GHL_API_KEY                    — GHL private token (enables contact lookup)
//   GHL_LOCATION_ID                — GHL sub-account location ID
//   ADMIN_NOTIFY_WEBHOOK_URL       — GHL inbound webhook URL that fires the admin notification
//   GHL_WEBHOOK_SECRET             — Shared secret to validate incoming GHL calls
//
// Active member check uses Airtable "Member Status" field (value: "Active" or "Inactive").
// GHL tags are NOT used.

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIVE_MEMBER_STATUS = "active";

// Maps GHL survey ID → { name, type }.
// null = excluded (skip silently). Add new surveys here as needed.
const SURVEY_ID_MAP = {
  "8CzJrtK4SZ8KuOFkpc9q": { name: "BRRRRR Readiness Survey",                    type: "BRRRR" },
  "DhnDb2SsytJF6bacAafd": { name: "Fix & Flip Readiness Survey",                type: "Fix & Flip" },
  "12zEvlS4FVglce7fWUTN": { name: "BuildScope Ai Estimator Readiness Survey",   type: "Rehab Estimator" },
  "83hyIL3oCuS0Sp29QVyN": { name: "Rental Readiness Survey",                    type: "Rentals" },
  "jhrib8YKGa00UDFevyaQ": { name: "Short Term Readiness Survey",                type: "Short Term" },
  "w5e3kPk4jK60mJFjKfWo": { name: "Wholesaler Readiness Survey",                type: "Wholesale" },
  "lJqvIwt2mIPKmf9OqFUu": null, // Rehab Estimator Readiness Survey Old — excluded
};

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-ghl-secret");

  if (req.method === "OPTIONS") return res.status(200).send("OK");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ── Optional webhook secret validation ──────────────────────────────────
    const WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET;
    if (WEBHOOK_SECRET) {
      const incoming = req.headers["x-ghl-secret"] || req.headers["x-webhook-secret"];
      if (incoming !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const { name, email, phone, surveyId, contactId, notes } = body;

    if (!surveyId) {
      return res.status(400).json({ error: "surveyId is required" });
    }

    // ── Resolve survey from ID ───────────────────────────────────────────────
    const surveyEntry = SURVEY_ID_MAP[surveyId];

    if (surveyEntry === undefined) {
      console.log(`Unknown surveyId "${surveyId}" — skipping`);
      return res.status(200).json({ ok: true, skipped: true, reason: "unknown survey" });
    }

    if (surveyEntry === null) {
      console.log(`Excluded surveyId "${surveyId}" — skipping`);
      return res.status(200).json({ ok: true, skipped: true, reason: "excluded survey" });
    }

    const { name: surveyName, type: calculatorType } = surveyEntry;

    const normalizedPhone = normalizePhone(phone);

    if (!email && !normalizedPhone && !contactId) {
      return res.status(400).json({ error: "At least one of email, phone, or contactId is required" });
    }

    // ── Env vars ────────────────────────────────────────────────────────────
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

    // ── 1. GHL contact lookup ───────────────────────────────────────────────
    const GHL_TOKEN    = process.env.GHL_API_KEY;
    const GHL_LOCATION = process.env.GHL_LOCATION_ID;

    let knownGHLContact = false;

    if (GHL_TOKEN && GHL_LOCATION) {
      const ghlContact = await getGHLContact({ phone: normalizedPhone, email, token: GHL_TOKEN, locationId: GHL_LOCATION });
      knownGHLContact  = !!ghlContact;
    }

    // ── 2. Airtable — find existing record ──────────────────────────────────
    let existingRecordId = null;
    let existingFields   = {};

    if (normalizedPhone || email) {
      const conditions = [];
      if (normalizedPhone) {
        conditions.push(
          `RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number},'(',''  ),')',''  ),'-',''  ),' ',''  ),10)='${normalizedPhone}'`
        );
      }
      if (email) {
        conditions.push(`{Email}='${email.replace(/'/g, "\\'")}'`);
      }

      const filter    = conditions.length === 1 ? conditions[0] : `OR(${conditions.join(",")})`;
      const searchUrl = new URL(tableUrl);
      searchUrl.searchParams.set("filterByFormula", filter);
      searchUrl.searchParams.set("maxRecords", "1");

      const searchResp = await fetch(searchUrl.toString(), {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      });
      const searchData = await searchResp.json();

      if (searchData.records?.length > 0) {
        existingRecordId = searchData.records[0].id;
        existingFields   = searchData.records[0].fields || {};
      }
    }

    const activeMember = (existingFields["Member Status"] || "").toLowerCase() === ACTIVE_MEMBER_STATUS;
    const isNewRecord  = !existingRecordId;

    // ── 3. Multi-interest tracking ──────────────────────────────────────────
    const existingInterests = Array.isArray(existingFields["Calculator Interests"])
      ? existingFields["Calculator Interests"]
      : [];
    const mergedInterests  = existingInterests.includes(calculatorType)
      ? existingInterests
      : [...existingInterests, calculatorType];
    const newInterestAdded = !existingInterests.includes(calculatorType);

    // ── 4. Priority score ───────────────────────────────────────────────────
    const { score: priorityScore, level: priorityLevel } = calcPriorityScore({
      activeMember,
      knownGHLContact,
      interestCount: mergedInterests.length,
      isNewRecord,
    });

    // ── 5. Access status (auto-approve active members) ──────────────────────
    const existingStatus = existingFields["Access Status"];
    const accessStatus   = existingStatus && existingStatus !== "Pending"
      ? existingStatus
      : activeMember ? "Approved" : "Pending";

    // ── 6. Build Airtable fields ────────────────────────────────────────────
    const capitalizedName = capitalizeName(name);

    const fields = {
      ...(capitalizedName ? { "Name":           capitalizedName }     : {}),
      ...(email           ? { "Email":          email.toLowerCase() } : {}),
      ...(normalizedPhone ? { "Phone Number":   normalizedPhone }      : {}),
      ...(contactId       ? { "GHL Contact ID": contactId }            : {}),
      "Survey Name":          surveyName,
      "Calculator Type":      calculatorType,
      "Calculator Interests": mergedInterests,
      "Request Date":         today,
      "Access Status":        accessStatus,
      "Priority Score":       priorityScore,
      "Priority Level":       priorityLevel,
      ...(notes ? { "Notes": notes } : {}),
    };

    // ── 7. Write to Airtable ────────────────────────────────────────────────
    let result;

    if (existingRecordId) {
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
    const action   = isNewRecord ? "created" : "updated";

    console.log(
      `Deal access ${action} — record ${recordId} | survey: "${surveyName}" | ` +
      `status: ${accessStatus} | score: ${priorityScore} (${priorityLevel}) | ` +
      `interests: [${mergedInterests.join(", ")}]`
    );

    // ── 8. Admin notification ───────────────────────────────────────────────
    const NOTIFY_URL = process.env.ADMIN_NOTIFY_WEBHOOK_URL;
    if (NOTIFY_URL) {
      await notifyAdmin(NOTIFY_URL, {
        name:             capitalizedName || name || "Unknown",
        email:            email           || "",
        phone:            normalizedPhone || phone || "",
        surveyName,
        calculatorType,
        interests:        mergedInterests,
        accessStatus,
        priorityScore,
        priorityLevel,
        isNewRequest:     isNewRecord,
        newInterestAdded,
        airtableRecordId: recordId,
        submittedAt:      new Date().toISOString(),
      });
    }

    // ── 9. Response ─────────────────────────────────────────────────────────
    return res.status(200).json({
      ok:              true,
      recordId,
      action,
      survey:          surveyName,
      calculatorType,
      interests:       mergedInterests,
      newInterestAdded,
      accessStatus,
      priorityScore,
      priorityLevel,
    });

  } catch (err) {
    console.error("survey-deal-access error:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalizeName(name) {
  if (!name) return "";
  return name.trim().split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function getGHLContact({ phone, email, token, locationId }) {
  const query = phone || email;
  if (!query) return null;

  try {
    const url = new URL("https://services.leadconnectorhq.com/contacts/search");
    url.searchParams.set("locationId", locationId);
    url.searchParams.set("query", query);
    url.searchParams.set("page", "1");
    url.searchParams.set("pageLimit", "1");

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
      },
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.contacts?.[0] || null;
  } catch {
    return null;
  }
}

// +40 active member · +20 known GHL contact · +10 per interest (max 5) · +10 first submission
function calcPriorityScore({ activeMember, knownGHLContact, interestCount, isNewRecord }) {
  let score = 0;
  if (activeMember)    score += 40;
  if (knownGHLContact) score += 20;
  score += Math.min(interestCount, 5) * 10;
  if (isNewRecord)     score += 10;

  const level = score >= 60 ? "High" : score >= 30 ? "Medium" : "Low";
  return { score, level };
}

async function notifyAdmin(webhookUrl, payload) {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) console.warn(`Admin notification returned ${resp.status}`);
  } catch (err) {
    console.warn("Admin notification failed:", err.message);
  }
}