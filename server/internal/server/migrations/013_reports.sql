-- A member reports a message to moderators (1119). The text is a copy, so a
-- report outlives an edit or a delete. Resolving deletes the rows.
CREATE TABLE reports (
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
  UNIQUE (message_id, reporter_id)
);
