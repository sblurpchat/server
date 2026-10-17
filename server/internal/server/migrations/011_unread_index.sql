-- Unread counts (readState) look at every message after a seq, replies too.
-- messages_channel puts thread_root_id before created_seq, so that range
-- scanned the whole channel (1155).
CREATE INDEX messages_unread ON messages(channel_id, created_seq);
