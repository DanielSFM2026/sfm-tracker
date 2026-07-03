-- WFI Clock Sync — one-time database setup
-- Run in: Supabase Dashboard → SQL Editor

-- 1. Map tracker employees to Workflow Infinity IDs.
--    Badge codes were built from WFI clock numbers (ASY-352 → WFI id 352),
--    so the mapping is derived automatically from the badge suffix.
alter table employees add column if not exists wfi_id integer;

update employees
set wfi_id = nullif(regexp_replace(badge_code, '\D', '', 'g'), '')::int
where wfi_id is null;

-- 2. Ledger of processed swipes (idempotency + audit trail).
create table if not exists clock_swipes (
  wfi_id       integer     not null,
  swipe_ts     timestamptz not null,
  person_name  text,
  action_taken text,
  processed_at timestamptz not null default now(),
  primary key (wfi_id, swipe_ts)
);

-- 3. Schedule the sync every 2 minutes.
--    Requires the pg_cron and pg_net extensions (Database → Extensions if this errors).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'wfi-clock-sync',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://xofsdsmtvraoldznmrxf.supabase.co/functions/v1/wfi-clock-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvZnNkc210dnJhb2xkem5tcnhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMDM1MTUsImV4cCI6MjA5Nzg3OTUxNX0.UzACOGODLgCVgXTAAJcpBpG7805wCdvKrvX3leU8-Pw'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To pause the sync later:  select cron.unschedule('wfi-clock-sync');
-- To watch what it's doing: select * from clock_swipes order by processed_at desc limit 50;
