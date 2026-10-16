-- Banned logins. A banned (iss, sub) cannot Join again.
CREATE TABLE bans (
  iss       TEXT NOT NULL,
  sub       TEXT NOT NULL,
  member_id TEXT NOT NULL,
  by_id     TEXT NOT NULL,
  at_ms     INTEGER NOT NULL,
  PRIMARY KEY (iss, sub)
);
