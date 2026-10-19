-- 1256, 1257: a report keeps the ids of its message's attachments (the
-- files stay while it is open), and resolving marks it instead of deleting
-- it. One open report per message and reporter; a later report of the same
-- message after a resolve is a new row. Rebuilt to drop the old UNIQUE.
CREATE TABLE reports_new (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  dm             INTEGER NOT NULL,
  author_id      TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  thread_root_id TEXT NOT NULL,
  reporter_id    TEXT NOT NULL,
  note           TEXT NOT NULL,
  at_ms          INTEGER NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  resolved_by    TEXT NOT NULL DEFAULT '',
  resolved_at_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO reports_new(id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms)
  SELECT id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE UNIQUE INDEX reports_open ON reports(message_id, reporter_id) WHERE resolved_at_ms = 0;
