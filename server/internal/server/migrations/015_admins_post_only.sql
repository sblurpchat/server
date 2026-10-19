-- 1290: only admins and the owner post top-level messages in this channel.
ALTER TABLE channels ADD COLUMN admins_post_only INTEGER NOT NULL DEFAULT 0;
