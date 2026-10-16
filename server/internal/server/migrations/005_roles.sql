-- Custom roles decide who can see text channels (channel_roles). Text
-- channels now keep a member list too, like private channels: in ROLES mode
-- everyone who can see the channel, in OPT_IN mode those who joined it.
CREATE TABLE roles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color         TEXT NOT NULL DEFAULT '',
  position      INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE member_roles (
  member_id TEXT NOT NULL,
  role_id   TEXT NOT NULL,
  PRIMARY KEY (member_id, role_id)
);
CREATE INDEX member_roles_role ON member_roles(role_id);
CREATE TABLE channel_roles (
  channel_id TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, role_id)
);
CREATE INDEX channel_roles_role ON channel_roles(role_id);
ALTER TABLE channels ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO channel_members(channel_id, member_id)
  SELECT c.id, m.id FROM channels c, members m WHERE c.kind = 1 AND m.deleted = 0;
-- Text channel events used to go to everyone. Drop them so a client behind
-- resyncs instead of replaying them under the new rules. seq keeps counting.
DELETE FROM events;
