-- 1308: who may start top-level messages, like channel_roles for seeing.
-- No rows: everyone. "admin" alone: admins and the owner. "moderator":
-- moderators too. Other ids are custom roles. Replaces admins_post_only (015).
CREATE TABLE channel_post_roles (
  channel_id TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, role_id)
);
INSERT INTO channel_post_roles(channel_id, role_id) SELECT id, 'admin' FROM channels WHERE admins_post_only = 1;
ALTER TABLE channels DROP COLUMN admins_post_only;
