-- 1507: a report about a member has message_id '' and author_id = the
-- member, so the open-report key adds author_id. For a message report the
-- message fixes the author, so nothing changes there.
DROP INDEX reports_open;
CREATE UNIQUE INDEX reports_open ON reports(message_id, author_id, reporter_id) WHERE resolved_at_ms = 0;
