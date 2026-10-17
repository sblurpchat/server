-- Optional image behind a channel's header: an attachments id, '' = none.
-- The community banner lives in settings under key 'banner'. Both keep
-- their upload out of the orphan prune.
ALTER TABLE channels ADD COLUMN header_image_id TEXT NOT NULL DEFAULT '';
