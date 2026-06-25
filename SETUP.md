# Welder Job Tracker — Setup Guide

## 1. Prerequisites

Install **Node.js** (LTS, v20+): https://nodejs.org/en/download
This gives you `node` and `npm` in your terminal.

## 2. Supabase project

1. Create a free project at https://supabase.com
2. In the Supabase SQL Editor, paste the entire contents of `supabase/schema.sql` and run it.
   This creates the four tables and seeds the Mon–Fri break schedule.
3. Go to **Project Settings → API** and copy:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon/public key** (a long JWT string)

## 3. Environment variables

```
cp .env.example .env
```

Edit `.env` and fill in your Supabase URL and anon key.

## 4. Install and run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a browser.
To test badge scanning, click in the visible scan input box and type a badge code + Enter.

## 5. Add employee records

In the Supabase SQL Editor (or Table Editor):

```sql
INSERT INTO employees (badge_code, full_name) VALUES
  ('1234', 'Alice Smith'),
  ('5678', 'Bob Jones');
```

`badge_code` is exactly what the barcode scanner produces when a badge is scanned.

## 6. Barcode format

Job barcodes are parsed as `{PO_NUMBER}-{PART_NUMBER}` — the part before the
first dash is the PO number, everything after is the part number.

**To change this:** edit the `parseJobBarcode()` function in `src/lib/timeCalc.js`.

## 7. Deploy to production (kiosk)

### Option A — Vercel (recommended, free)
```bash
npm install -g vercel
vercel --prod
```
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables
in the Vercel dashboard under Project → Settings → Environment Variables.

### Option B — Static hosting (Netlify, Cloudflare Pages, etc.)
```bash
npm run build      # outputs to dist/
```
Upload the `dist/` folder. Set the same two env vars in your host's dashboard.

### Kiosk setup on Seuic scanners
1. Navigate to the deployed URL in the browser.
2. Tap the browser menu → "Add to Home Screen" (installs as a PWA, runs fullscreen).
3. Set the launcher to auto-open the PWA on boot if desired.

## 8. Break rules

Edit the `break_rules` table directly in Supabase to change break times — no code change needed.

| weekday | start_time | duration_minutes |
|---------|------------|-----------------|
| Mon     | 10:00      | 15              |
| Mon     | 13:00      | 30              |
| ...     | ...        | ...             |

## 9. Phase 2 — Manager dashboard

The schema is ready for a reporting view. A simple query for current active jobs:

```sql
SELECT
  e.full_name,
  j.po_number,
  j.part_number,
  MAX(je.event_timestamp) AS last_event,
  je2.event_type AS current_status
FROM job_events je
JOIN employees e ON e.employee_id = je.employee_id
JOIN jobs j ON j.job_id = je.job_id
-- ... (group and filter for active sessions)
```

A Supabase view or PostgREST function can expose this to a dashboard
(Metabase, Grafana, or a second web page) without touching the kiosk app.
