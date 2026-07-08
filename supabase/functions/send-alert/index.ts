import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// Who receives ⚑ issue reports — edit this list and redeploy to change it
const RECIPIENTS = [
  'daniel@sfmengineering.co.uk',
]

// Requires the sfmengineering.co.uk domain to be Verified in Resend
const FROM = 'SFM Job Tracker <alerts@sfmengineering.co.uk>'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { poNumber, partNumber, message, employeeName, lineName } = await req.json()
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''

    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    FROM,
        to:      RECIPIENTS,
        subject: `⚑ Job Issue — ${lineName ?? 'Shop Floor'} · PO ${poNumber}`,
        html: `
          <p><strong>Area:</strong> ${lineName ?? '—'}</p>
          <p><strong>PO:</strong> ${poNumber} · ${partNumber}</p>
          <p><strong>Raised by:</strong> ${employeeName}</p>
          <p><strong>Message:</strong></p>
          <p>${message.replace(/\n/g, '<br>')}</p>
          <hr>
          <p style="color:#999;font-size:12px">SFM Job Tracker</p>
        `,
      }),
    })

    const data = await res.json()
    if (!res.ok) throw new Error(JSON.stringify(data))

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS }
    })
  }
})
