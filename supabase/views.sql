-- ─────────────────────────────────────────────────────────────────────────────
-- SFM Job Tracker — Reporting Views
-- Run this in the Supabase SQL Editor.
-- Safe to re-run: uses CREATE OR REPLACE VIEW.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. vw_credited_intervals ──────────────────────────────────────────────────
-- One row per work interval (START/RESUME → PAUSE/COMPLETE/AUTO_LOGOUT).
-- credited_hours = raw duration ÷ split_count (already accounts for split jobs).
-- Open intervals (still active right now) use NOW() as the end time.
-- Break deduction is NOT applied here — add it in Power BI if needed,
-- or use vw_job_hours_by_day which will be updated when break logic is added.

CREATE OR REPLACE VIEW vw_credited_intervals AS
WITH ordered AS (
  SELECT
    event_id,
    employee_id,
    job_id,
    line_id,
    event_type,
    event_timestamp,
    split_count,
    LEAD(event_timestamp) OVER (
      PARTITION BY employee_id, job_id
      ORDER BY event_timestamp
    ) AS next_ts,
    LEAD(event_type) OVER (
      PARTITION BY employee_id, job_id
      ORDER BY event_timestamp
    ) AS next_type
  FROM job_events
  WHERE event_type IN ('START','RESUME','PAUSE','COMPLETE','AUTO_LOGOUT')
)
SELECT
  o.event_id,
  o.employee_id,
  emp.full_name                                    AS employee_name,
  emp.department,
  emp.sub_department,
  o.job_id,
  j.po_number,
  j.part_number,
  j.quantity,
  j.status                                         AS job_status,
  o.line_id,
  o.event_type                                     AS start_event,
  o.event_timestamp                                AS interval_start,
  COALESCE(o.next_ts, NOW())                       AS interval_end,
  (o.next_ts IS NULL)                              AS is_open,
  o.split_count,
  -- Raw duration in hours (before split)
  ROUND(
    EXTRACT(EPOCH FROM (COALESCE(o.next_ts, NOW()) - o.event_timestamp)) / 3600.0
  , 4)                                             AS raw_hours,
  -- Credited hours: each person's fair share when jobs are split
  ROUND(
    EXTRACT(EPOCH FROM (COALESCE(o.next_ts, NOW()) - o.event_timestamp)) / 3600.0
    / GREATEST(o.split_count, 1)
  , 4)                                             AS credited_hours,
  DATE(o.event_timestamp)                          AS work_date,
  EXTRACT(ISOYEAR FROM o.event_timestamp)          AS iso_year,
  EXTRACT(WEEK    FROM o.event_timestamp)          AS week_number,
  TO_CHAR(o.event_timestamp, 'Dy')                 AS weekday
FROM ordered o
JOIN employees emp ON emp.employee_id = o.employee_id
JOIN jobs       j  ON j.job_id        = o.job_id
WHERE o.event_type IN ('START','RESUME')
  AND (
    o.next_type IN ('PAUSE','COMPLETE','AUTO_LOGOUT')
    OR o.next_ts IS NULL   -- open interval
  );


-- ── 2. vw_job_hours_by_day ───────────────────────────────────────────────────
-- One row per employee × job × date.
-- Use this in Power BI as your primary fact table for job-level analysis.
-- Matches the "Logged Job Hours" column in your existing report.

CREATE OR REPLACE VIEW vw_job_hours_by_day AS
SELECT
  employee_id,
  employee_name,
  department,
  sub_department,
  job_id,
  po_number,
  part_number,
  quantity,
  job_status,
  line_id,
  work_date,
  iso_year,
  week_number,
  SUM(credited_hours)  AS credited_hours,
  SUM(raw_hours)       AS raw_hours,
  BOOL_OR(is_open)     AS has_open_interval
FROM vw_credited_intervals
GROUP BY
  employee_id, employee_name, department, sub_department,
  job_id, po_number, part_number, quantity, job_status, line_id,
  work_date, iso_year, week_number;


-- ── 3. vw_job_hours_total ─────────────────────────────────────────────────────
-- Total credited hours per employee × job (all time, no date split).
-- Useful for comparing total job hours against your target hours from the build plan.

CREATE OR REPLACE VIEW vw_job_hours_total AS
SELECT
  employee_id,
  employee_name,
  department,
  sub_department,
  job_id,
  po_number,
  part_number,
  quantity,
  job_status,
  line_id,
  MIN(work_date)         AS first_worked,
  MAX(work_date)         AS last_worked,
  COUNT(DISTINCT work_date) AS days_worked,
  SUM(credited_hours)    AS credited_hours,
  BOOL_OR(has_open_interval) AS is_active
FROM vw_job_hours_by_day
GROUP BY
  employee_id, employee_name, department, sub_department,
  job_id, po_number, part_number, quantity, job_status, line_id;


-- ── 4. vw_employee_hours_by_day ──────────────────────────────────────────────
-- Total credited hours per employee per day across ALL jobs.
-- Compare this against your NorthTime clocked hours export to find unallocated time.
-- Join on employee_name + work_date in Power BI.

CREATE OR REPLACE VIEW vw_employee_hours_by_day AS
SELECT
  employee_id,
  employee_name,
  department,
  sub_department,
  work_date,
  iso_year,
  week_number,
  SUM(credited_hours)      AS logged_job_hours,
  COUNT(DISTINCT job_id)   AS jobs_worked,
  BOOL_OR(has_open_interval) AS has_open_interval
FROM vw_job_hours_by_day
GROUP BY
  employee_id, employee_name, department, sub_department,
  work_date, iso_year, week_number;


-- ── 5. vw_assembly_job_hours ──────────────────────────────────────────────────
-- Assembly-specific view: total team hours per job (manager share + each member).
-- One row per job showing combined team effort and individual breakdown.

CREATE OR REPLACE VIEW vw_assembly_job_hours AS
SELECT
  job_id,
  po_number,
  part_number,
  quantity,
  job_status,
  line_id,
  MIN(work_date)                 AS first_worked,
  MAX(work_date)                 AS last_worked,
  SUM(credited_hours)            AS total_team_hours,
  COUNT(DISTINCT employee_id)    AS team_size,
  BOOL_OR(has_open_interval)     AS is_active
FROM vw_job_hours_by_day
WHERE department = 'assembly' OR line_id IS NOT NULL
GROUP BY job_id, po_number, part_number, quantity, job_status, line_id;
