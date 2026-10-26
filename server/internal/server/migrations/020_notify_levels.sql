-- 1498: a member's notification level per channel, or for the whole
-- community when channel_id is ''. No row means the default (ALL).
CREATE TABLE notify_levels (
  member_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  level      INTEGER NOT NULL,
  PRIMARY KEY (member_id, channel_id)
);
