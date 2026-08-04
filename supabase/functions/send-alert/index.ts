import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// Edge secrets (Supabase Dashboard -> Edge Functions -> Secrets) — same
// pattern as tank-tracker's tank-email function:
//   RESEND_API_KEY        — from resend.com (shared across functions in this project)
//   SEND_ALERT_TO         — recipients for weld/paint/kitting alerts, comma-separated;
//                           defaults to DEFAULT_TO below until set.
//   SEND_ALERT_TO_ASSEMBLY — recipients for assembly alerts, comma-separated; falls
//                           back to SEND_ALERT_TO until set (so it's safe to leave unset).
//   SEND_ALERT_FROM       — e.g. "SFM Job Tracker <alerts@sfmengineering.co.uk>";
//                           requires that domain Verified in Resend.
// No redeploy needed to change any of these — they're read fresh on every call.

const DEFAULT_TO = 'daniel@sfmengineering.co.uk'
const DEFAULT_FROM = 'SFM Job Tracker <onboarding@resend.dev>'   // safe fallback if the secret is ever unset

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { poNumber, partNumber, message, employeeName, lineName, department } = await req.json()
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY secret not set')

    const from = Deno.env.get('SEND_ALERT_FROM') ?? DEFAULT_FROM
    const baseToStr = (Deno.env.get('SEND_ALERT_TO') ?? DEFAULT_TO).trim()
    const toStr = department === 'assembly'
      ? (Deno.env.get('SEND_ALERT_TO_ASSEMBLY') ?? baseToStr).trim()
      : baseToStr
    const to = toStr.split(',').map(s => s.trim()).filter(Boolean)
    if (!to.length) throw new Error('Recipient list is empty after parsing')

    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
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
