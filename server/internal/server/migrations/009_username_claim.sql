-- The preferred_username last seen in a member's token, so a rename on
-- sblurp.chat reaches the community (1095). '' means not seen yet.
ALTER TABLE members ADD COLUMN username_claim TEXT NOT NULL DEFAULT '';
