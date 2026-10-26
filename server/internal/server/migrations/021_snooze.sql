-- 1515: a member's push snooze, unix ms; no pushes before it.
ALTER TABLE members ADD COLUMN snooze_until INTEGER NOT NULL DEFAULT 0;
