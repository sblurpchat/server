-- 1324: a video's still image, an attachments id ('' = none). The poster row
-- keeps message_id NULL so it is never listed as its own attachment.
ALTER TABLE attachments ADD COLUMN poster_id TEXT NOT NULL DEFAULT '';
CREATE INDEX attachments_poster ON attachments(poster_id) WHERE poster_id != '';
