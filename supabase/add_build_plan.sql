-- ============================================================
-- Build Plan — synced, read-only mirror of the Excel schedule.
-- Feeds the "Weekly Plan" tab: a worker picks a planned job by
-- department + week instead of scanning a cover-page barcode.
-- Selecting a job runs the same findOrCreateJob(po, part, dept)
-- path as a scan, so this joins to live `jobs` by (po_number,
-- part_number). Kept separate from jobs/job_events so a re-sync
-- never touches live status or the event log.
-- Run in the Supabase SQL editor.
-- ============================================================

create table if not exists build_plan (
  plan_id        uuid primary key default gen_random_uuid(),
  seq_no         integer unique,          -- Excel OLD SEQ — stable key for upserts
  po_number      text,
  part_number    text,
  wo_number      text,
  sage_wo        text,
  model          text,                    -- MODELS column (populated on every row)
  description    text,
  customer       text,                    -- DELIVERED TO
  finish         text,
  quantity       integer,
  nest_code      text,
  fab_cat        text,
  sub_line       text,
  code           text,                    -- dept routing / finishing-stage indicator

  -- Department planned weeks. TEXT on purpose: a cell may hold a week
  -- number, 'COMPLETE', or a tag like 'RM'/'SC'. Tab maps dept → column:
  --   kitting → kit_week   weld → fab_week   paint → paint_week   assembly → subs_week
  kit_week       text,                    -- KITTED BY WEEK
  fab_week       text,                    -- PLANNED FAB/WELD WEEK
  paint_week     text,                    -- PLANNED PAINT WEEK
  paint_out_week text,                    -- PAINT - OUTSOURCE WK
  subs_week      text,                    -- PLANNED SUBS WEEK

  -- Granular stage target weeks (C F K K-SO W P S)
  cut_week         text,
  fold_week        text,
  kitting_week     text,
  kitting_so       text,
  weld_week        text,
  painting_week    text,
  subassembly_week text,

  -- Key dates (TEXT — the sheet mixes week numbers and dd/mm/yy)
  po_received       text,
  original_date     text,
  customer_req_date text,
  realign_date      text,
  delivered         text,
  del_date          text,

  -- Sync metadata
  source         text not null default 'excel_import',
  synced_at      timestamptz not null default now()
);

create index if not exists idx_build_plan_po_part  on build_plan (po_number, part_number);
create index if not exists idx_build_plan_fab_week  on build_plan (fab_week);
create index if not exists idx_build_plan_customer  on build_plan (customer);

-- RLS: match the app's kiosk model (anon key full access).
alter table build_plan enable row level security;
create policy "public_all" on build_plan for all using (true) with check (true);
