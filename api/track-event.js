// /api/track-event.js
//
// Receives a calculator behavior event from the frontend and forwards it
// to a GHL inbound webhook to trigger automated follow-up workflows.
//
// Currently handled events:
//   finish_analysis — user clicked "Finish Analysis" after completing a deal
//
// Required env var:
//   GHL_FINISH_ANALYSIS_WEBHOOK_URL — GHL inbound webhook URL for the
//                                     "Finish Analysis Follow-up" workflow
//
// Payload accepted (POST JSON):
//   { phone: "8015551234", calculator: "Wholesale", event: "finish_analysis" }

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { phone: rawPhone, calculator, event } = req.body || {};

  if (!rawPhone || !calculator || !event) {
    return res.status(400).json({ error: 'Missing required fields: phone, calculator, event' });
  }

  // Normalize to E.164 format (+1XXXXXXXXXX) for GHL contact lookup
  const digits = String(rawPhone).replace(/\D/g, '').slice(-10);
  const phone = `+1${digits}`;

  const webhookUrl = process.env.GHL_FINISH_ANALYSIS_WEBHOOK_URL
                  || process.env.GHL_PDF_DOWNLOAD_WEBHOOK_URL; // fallback during transition
  if (!webhookUrl) {
    console.warn('GHL_FINISH_ANALYSIS_WEBHOOK_URL not set — skipping event tracking');
    return res.status(200).json({ ok: true, tracked: false });
  }

  try {
    const ghlRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        calculator,
        event,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!ghlRes.ok) {
      console.error('GHL webhook returned non-OK status:', ghlRes.status);
    }

    return res.status(200).json({ ok: true, tracked: true });
  } catch (err) {
    console.error('Failed to fire GHL webhook:', err.message);
    return res.status(200).json({ ok: true, tracked: false });
  }
}