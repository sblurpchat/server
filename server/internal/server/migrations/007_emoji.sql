-- Custom emoji. The id is in the image URL (/emoji/{id}) and is never
-- reused, so the image behind a URL never changes. data is last so listing
-- names does not read the images. settings 'emoji_version' holds the seq
-- of the last emoji change; it is the list's ETag.
CREATE TABLE emoji (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  data BLOB NOT NULL
);
