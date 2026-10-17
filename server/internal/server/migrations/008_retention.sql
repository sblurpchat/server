-- Message retention (1072): find old messages and a root's replies without a scan.
CREATE INDEX messages_created ON messages(created_at_ms) WHERE thread_root_id = '';
CREATE INDEX messages_thread ON messages(thread_root_id) WHERE thread_root_id != '';
