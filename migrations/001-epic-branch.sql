ALTER TABLE epics ADD COLUMN IF NOT EXISTS branch TEXT;
CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch);
