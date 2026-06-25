-- Add split_count to job_events so each START/RESUME records how many ways
-- the employee's time is being divided at that moment.
-- DEFAULT 1 means all existing events are treated as undivided (correct).
ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS split_count integer NOT NULL DEFAULT 1;
