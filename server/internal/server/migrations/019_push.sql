-- 0110: the push handle from the member's latest access token (an opaque
-- string from their account server) and whether they want message text in
-- notifications. '' means no pushes.
ALTER TABLE members ADD COLUMN push_handle TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN push_preview INTEGER NOT NULL DEFAULT 0;
