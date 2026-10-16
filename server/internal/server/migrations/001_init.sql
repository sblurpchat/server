CREATE TABLE members (
  id           TEXT PRIMARY KEY,
  kind         INTEGER NOT NULL,
  role         INTEGER NOT NULL,
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url   TEXT NOT NULL DEFAULT '',
  bio          TEXT NOT NULL DEFAULT '',
  status_text  TEXT NOT NULL DEFAULT '',
  status_emoji TEXT NOT NULL DEFAULT '',
  joined_at_ms INTEGER NOT NULL,
  joined_seq   INTEGER NOT NULL DEFAULT 0, -- unread counts start here
  iss          TEXT,                       -- humans who log in: (iss, sub)
  sub          TEXT,
  token_hash   TEXT UNIQUE,                -- bots: sha256 hex of the token
  deleted      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (iss, sub)
);

CREATE TABLE channels (
  id               TEXT PRIMARY KEY,
  kind             INTEGER NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  topic            TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT '',
  position         INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  dm_key           TEXT UNIQUE -- sorted member ids, DMs only
);
CREATE UNIQUE INDEX channels_name ON channels(name) WHERE kind != 3;

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_id)
);
CREATE INDEX channel_members_member ON channel_members(member_id);

CREATE TABLE messages (
  n                INTEGER PRIMARY KEY, -- stable rowid for FTS
  id               TEXT NOT NULL UNIQUE,
  channel_id       TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  text             TEXT NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  edited_at_ms     INTEGER NOT NULL DEFAULT 0,
  deleted          INTEGER NOT NULL DEFAULT 0,
  thread_root_id   TEXT NOT NULL DEFAULT '',
  reply_count      INTEGER NOT NULL DEFAULT 0,
  last_reply_at_ms INTEGER NOT NULL DEFAULT 0,
  client_id        TEXT NOT NULL DEFAULT '',
  created_seq      INTEGER NOT NULL, -- seq of message_created
  seq              INTEGER NOT NULL  -- seq of the last change
);
CREATE INDEX messages_channel ON messages(channel_id, thread_root_id, created_seq);
CREATE UNIQUE INDEX messages_client ON messages(author_id, client_id) WHERE client_id != '';

CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='n');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.n, new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.n, old.text);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.n, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.n, new.text);
END;

CREATE TABLE reactions (
  message_id TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, member_id)
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  uploader_id   TEXT NOT NULL,
  message_id    TEXT,
  name          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id);

CREATE TABLE read_states (
  member_id     TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL,
  PRIMARY KEY (member_id, channel_id)
);

-- Every persisted event. scope_member set: only that member sees it.
-- scope_channel set: only members of that (private or DM) channel see it.
-- Both empty: every member sees it.
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms         INTEGER NOT NULL,
  scope_channel TEXT NOT NULL DEFAULT '',
  scope_member  TEXT NOT NULL DEFAULT '',
  payload       BLOB NOT NULL
);
