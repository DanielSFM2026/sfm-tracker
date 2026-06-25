-- ============================================================
-- Welder Job Tracker — Supabase / Postgres schema
-- Run this in the Supabase SQL editor to initialize the DB.
-- ============================================================

-- ── employees ──────────────────────────────────────────────
create table if not exists employees (
  employee_id   uuid primary key default gen_random_uuid(),
  badge_code    text unique not null,
  full_name     text not null,
  active        boolean not null default true
);

-- ── jobs ───────────────────────────────────────────────────
create table if not exists jobs (
  job_id      uuid primary key default gen_random_uuid(),
  po_number   text not null,
  part_number text not null,
  quantity    integer,
  status      text not null default 'not_started'
              check (status in ('not_started','in_progress','paused','completed')),
  created_at  timestamptz not null default now(),
  unique (po_number, part_number)
);

-- ── job_events ─────────────────────────────────────────────
create table if not exists job_events (
  event_id        uuid primary key default gen_random_uuid(),
  employee_id     uuid references employees(employee_id) on delete cascade,
  job_id          uuid references jobs(job_id) on delete cascade,
  event_type      text not null
                  check (event_type in (
                    'LOGIN','JOB_CREATED','START','PAUSE',
                    'RESUME','COMPLETE','AUTO_LOGOUT'
                  )),
  activity_type   text check (activity_type in ('tack','weld')),
  event_timestamp timestamptz not null default now()
);

create index if not exists idx_job_events_employee on job_events(employee_id);
create index if not exists idx_job_events_job     on job_events(job_id);
create index if not exists idx_job_events_ts      on job_events(event_timestamp);

-- ── break_rules ────────────────────────────────────────────
create table if not exists break_rules (
  rule_id          uuid primary key default gen_random_uuid(),
  weekday          text not null
                   check (weekday in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  start_time       time not null,
  duration_minutes integer not null
);

-- Seed current break schedule
insert into break_rules (weekday, start_time, duration_minutes) values
  ('Mon', '10:00', 15),
  ('Mon', '13:00', 30),
  ('Tue', '10:00', 15),
  ('Tue', '13:00', 30),
  ('Wed', '10:00', 15),
  ('Wed', '13:00', 30),
  ('Thu', '10:00', 15),
  ('Thu', '13:00', 30),
  ('Fri', '10:00', 15)
on conflict do nothing;

-- ── RLS: allow anon key full access (kiosk, no auth) ───────
-- If you want row-level security, replace these with proper policies.
alter table employees   enable row level security;
alter table jobs        enable row level security;
alter table job_events  enable row level security;
alter table break_rules enable row level security;

create policy "public_all" on employees   for all using (true) with check (true);
create policy "public_all" on jobs        for all using (true) with check (true);
create policy "public_all" on job_events  for all using (true) with check (true);
create policy "public_all" on break_rules for all using (true) with check (true);

-- ── Sample employees (remove / replace with real data) ─────
-- insert into employees (badge_code, full_name) values
--   ('EMP001', 'Alice Smith'),
--   ('EMP002', 'Bob Jones');
