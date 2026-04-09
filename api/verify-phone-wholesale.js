/**
 * Receives verification result from GHL workflow and saves to database
 * This endpoint is called BY the GHL workflow
 */

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { phone, approved, name } = req.body;

    console.log(`📞 Verification request: ${phone} - Approved: ${approved}`);

    // Airtable credentials for wholesale calculator
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY_WHOLESALE;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID_WHOLESALE;
    const AIRTABLE_TABLE = 'Verifications';

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      console.error('❌ Missing Airtable credentials');
      return res.status(500).json({ error: 'Database not configured' });
    }

    // Check if record exists (search by phone)
    const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?filterByFormula={Phone Number}="${phone}"`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const searchData = await searchRes.json();

    if (searchData.records && searchData.records.length > 0) {
      // Update existing record
      const recordId = searchData.records[0].id;
      const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`;

      await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'Approval Status': approved,
            'Name': name || '',
            'Timestamp': new Date().toISOString()
          }
        })
      });

      console.log(`✅ Updated verification for ${phone}`);
    } else {
      // Create new record
      const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;

      await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'Phone Number': phone,
            'Approval Status': approved,
            'Name': name || '',
            'Timestamp': new Date().toISOString()
          }
        })
      });

      console.log(`✅ Created verification for ${phone}`);
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error saving verification:', error);
    return res.status(500).json({ error: 'Failed to save verification' });
  }
}
