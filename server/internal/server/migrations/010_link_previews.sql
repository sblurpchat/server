-- Link previews (1110), keyed by normalized URL. ok = 0 caches a failure.
-- The image is fetched with the page and served from GET /unfurl/{id}, so
-- viewers never contact the linked site.
CREATE TABLE link_previews (
  url TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ok INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  site_name TEXT NOT NULL DEFAULT '',
  image_type TEXT NOT NULL DEFAULT '',
  image BLOB,
  fetched_at_ms INTEGER NOT NULL
);
