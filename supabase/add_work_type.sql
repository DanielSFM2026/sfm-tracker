-- Add work_type (Parts / Frames) to job_events
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS
  work_type text CHECK (work_type IN ('parts', 'frames'));

-- Expand activity_type to allow 'tack_weld'
ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_activity_type_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_activity_type_check
  CHECK (activity_type IN ('tack', 'weld', 'tack_weld'));
