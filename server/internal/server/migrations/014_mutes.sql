-- A member mutes another (1293): only the muter's unread counts change.
-- Separate from blocks so a mute never stops DMs and unblock keeps a mute.
CREATE TABLE mutes (
  muter_id TEXT NOT NULL,
  muted_id TEXT NOT NULL,
  at_ms    INTEGER NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);
