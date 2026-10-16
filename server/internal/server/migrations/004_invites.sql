-- Invite codes. Revoking deletes the row.
CREATE TABLE invites (
  code          TEXT PRIMARY KEY,
  created_by    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL DEFAULT 0, -- 0 = never
  max_uses      INTEGER NOT NULL DEFAULT 0, -- 0 = no limit
  uses          INTEGER NOT NULL DEFAULT 0
);
-- Community settings changed at runtime. A missing key has its default.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
