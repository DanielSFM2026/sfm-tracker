# Workflow Infinity clock sync — setup guide

Links Workflow Infinity clock-ins/outs to the job tracker. When a worker
swipes out, their active jobs pause (tagged "CLOCKED_OUT"); when they swipe
back in, only those clocked-out jobs resume. Manual holds are never touched.
Workers only scan between jobs.

## How it works

A Supabase Edge Function (`wfi-clock-sync`) runs every 2 minutes:

1. Logs into Workflow Infinity with its own credentials
2. Pulls today's "Personnel Clockings Over Date Range" report
3. Matches people by WFI ID = the number in their tracker badge code
   (ASY-352 → WFI id 352 — verified across all 62 employees)
4. For each new swipe: active jobs → pause · clocked-out jobs → resume
5. Records every swipe in the `clock_swipes` table (the audit trail)

Safety rails built in:
- A swipe never acts on a job that was started/paused/resumed AFTER the
  swipe happened (protects against acting on stale data after downtime)
- Swipes within 3 minutes of the previous one are ignored (double-badge)
- Timers stay accurate even if the sync runs late — events are written
  with the swipe time, not the processing time

## Setup steps (one-time, ~10 minutes)

### 1. Deploy the Edge Function

Supabase Dashboard → Edge Functions → Deploy a new function →
"Via Editor". Name it exactly `wfi-clock-sync`, paste the contents of
`functions/wfi-clock-sync/index.ts`, and deploy.

### 2. Add the Workflow Infinity login as secrets

Dashboard → Edge Functions → Secrets. Add:

| Name           | Value                       |
| -------------- | --------------------------- |
| `WFI_USERNAME` | the WFI login to use        |
| `WFI_PASSWORD` | its password                |

Recommended: create a dedicated user in Workflow Infinity for this
(e.g. "tracker-sync") with just enough access to run the clockings
report, rather than using your own login.

### 3. Run the database setup

Dashboard → SQL Editor → paste and run `wfi-clock-sync-setup.sql`.
This adds the `wfi_id` mapping, creates the `clock_swipes` audit table,
and schedules the function every 2 minutes.

### 4. Check it's working

- Edge Functions → wfi-clock-sync → Logs: each run prints a summary
  (swipes seen, jobs paused/resumed)
- SQL Editor: `select * from clock_swipes order by processed_at desc limit 50;`
- First run note: swipes from earlier today get recorded, but the
  causality guard means they won't disturb jobs people are already
  working on.

## Day-to-day behaviour

- Worker swipes out at 16:31 → within 2 minutes their jobs show paused
  (red "CLOCKED_OUT") in the manager view, timers stopped at 16:31
- Worker swipes in at 05:40 next morning → jobs resume, timers restart
  from 05:40
- Manager puts a job on hold → stays on hold through any number of
  swipes until someone resumes it deliberately
- Someone leaves early for an appointment and swipes back in later →
  paused at swipe-out, resumed at swipe-in, automatically

## Troubleshooting

- "WFI login failed" in logs → check the secrets; test the login manually
- Nothing appears in `clock_swipes` → check the cron job exists:
  `select * from cron.job;`
- To stop the sync: `select cron.unschedule('wfi-clock-sync');`
- If you wipe test data again, also `truncate table clock_swipes;`
