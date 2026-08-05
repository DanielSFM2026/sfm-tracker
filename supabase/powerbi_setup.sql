-- Power BI read-only access: a dedicated role + a job-duration view.
--
-- Why a view instead of raw tables: job time isn't stored directly — it's
-- derived from START/PAUSE/RESUME/COMPLETE/AUTO_LOGOUT events, split_count
-- (manager line-splits), and break_rules (paid break windows to subtract).
-- This view replicates src/lib/timeCalc.js's calcElapsed exactly in SQL so
-- Power BI sees the same hours the app shows, without re-deriving the logic.

-- ── Break-time helper (mirrors subtractBreaks in timeCalc.js) ────────────────
-- search_path pinned so this can't be tricked by a shadowing object earlier
-- in a caller's search_path (flagged by Supabase's linter otherwise).
create or replace function public.pb_break_seconds(p_start timestamptz, p_end timestamptz)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  rule record;
  local_midnight timestamptz;
  b_start timestamptz;
  b_end timestamptz;
  total numeric := 0;
  wd text;
begin
  wd := to_char(p_start at time zone 'Europe/London', 'Dy');
  local_midnight := date_trunc('day', p_start at time zone 'Europe/London') at time zone 'Europe/London';
  for rule in select * from public.break_rules where weekday = wd loop
    b_start := local_midnight + rule.start_time::time;
    b_end   := b_start + (rule.duration_minutes || ' minutes')::interval;
    total := total + greatest(0, extract(epoch from (least(p_end, b_end) - greatest(p_start, b_start))));
  end loop;
  return total;
end;
$$;

-- ── Job time view — one row per worked interval ───────────────────────────────
create or replace view public.powerbi_job_time as
with ordered as (
  select
    job_id, employee_id, event_type, event_timestamp, split_count, line_id,
    lead(event_type) over w        as next_type,
    lead(event_timestamp) over w   as next_ts
  from public.job_events
  where event_type in ('START','RESUME','PAUSE','COMPLETE','AUTO_LOGOUT')
  window w as (partition by job_id, employee_id order by event_timestamp)
),
intervals as (
  select
    job_id, employee_id, line_id,
    event_timestamp        as start_ts,
    next_ts                 as end_ts,
    coalesce(split_count,1) as split_count
  from ordered
  where event_type in ('START','RESUME')
    and next_type in ('PAUSE','COMPLETE','AUTO_LOGOUT')
    and next_ts is not null
)
select
  i.job_id,
  i.employee_id,
  e.full_name        as employee_name,
  e.sub_department,
  j.po_number,
  j.part_number,
  j.quantity,
  j.department,
  al.line_name,
  i.start_ts,
  i.end_ts,
  i.split_count,
  greatest(0, extract(epoch from (i.end_ts - i.start_ts)) - public.pb_break_seconds(i.start_ts, i.end_ts))
    / i.split_count / 3600.0 as hours
from intervals i
join public.employees e on e.employee_id = i.employee_id
join public.jobs j       on j.job_id = i.job_id
left join public.assembly_lines al on al.line_id = i.line_id;

comment on view public.powerbi_job_time is
  'Actual worked hours per job/employee interval, break-time deducted and split-count applied — matches the app''s live timers. One row per worked interval; sum(hours) grouped by job/department for totals.';

-- security_invoker: without this, the view runs with the view OWNER's
-- privileges rather than the querying role's — flagged as a Security
-- Definer View error by Supabase's linter. With it on, powerbi_reader
-- needs its own grant on every table the view touches (see below).
alter view public.powerbi_job_time set (security_invoker = true);

-- ── Read-only role for Power BI ────────────────────────────────────────────────
-- Password is set separately (not committed here) — see the Supabase dashboard
-- under Database > Roles, or rotate it with:
--   ALTER ROLE powerbi_reader WITH PASSWORD 'new-password-here';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    create role powerbi_reader login password 'CHANGE_ME_ON_FIRST_RUN';
  end if;
end
$$;

grant usage on schema public to powerbi_reader;
-- Note: with security_invoker on, powerbi_job_time runs as powerbi_reader —
-- so it needs SELECT on every table the view's query touches (job_events,
-- employees, jobs, assembly_lines, break_rules), not just the view itself.
grant select on public.job_alerts, public.build_plan, public.powerbi_job_time,
                 public.employees, public.jobs, public.assembly_lines,
                 public.job_events, public.break_rules to powerbi_reader;
-- Keep future tables out by default — grant new ones explicitly as they're added.
