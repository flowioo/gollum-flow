-- Opt-in fencing survives release: subsequent claims cannot downgrade it.
ALTER TABLE tasks ADD COLUMN lease_token TEXT;
ALTER TABLE tasks ADD COLUMN wait_reason TEXT;
