package server

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Activity and threads views (1405).
// ponytail: "my messages" and "threads I replied in" scan messages (no author index); add
// messages(author_id, thread_root_id) when a community gets big enough to notice.

func pageLimit(n int32) int {
	if n <= 0 {
		return 50
	}
	return int(min(n, 200))
}

// notHidden leaves out members ?1 blocked or muted.
const notHidden = `NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?1 UNION ALL SELECT muted_id FROM mutes WHERE muter_id = ?1)`

// activitySQL: ?1 me, ?2 "<@me>", ?3 FTS phrase for my id, ?4 retention cutoff, ?5 limit.
// Mentions go through the search index, then instr confirms the exact <@id>.
const activitySQL = `SELECT mid, kind, actor, emoji, at FROM (
	SELECT m.id AS mid, 1 AS kind, m.author_id AS actor, '' AS emoji, m.created_at_ms AS at FROM messages m
	WHERE m.n IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?3) AND instr(m.text, ?2) > 0
	AND m.author_id != ?1 AND m.deleted = 0 AND m.created_at_ms >= ?4 AND m.channel_id IN (` + searchMine1 + `)
	UNION ALL
	SELECT x.id, 2, x.author_id, '', x.created_at_ms FROM messages r JOIN messages x ON x.channel_id = r.channel_id AND x.thread_root_id = r.id
	WHERE r.author_id = ?1 AND r.thread_root_id = '' AND x.author_id != ?1 AND x.deleted = 0 AND instr(x.text, ?2) = 0
	AND x.created_at_ms >= ?4 AND x.channel_id IN (` + searchMine1 + `)
	UNION ALL
	SELECT m.id, 3, rc.member_id, rc.emoji, rc.at_ms FROM messages m JOIN reactions rc ON rc.message_id = m.id
	WHERE m.author_id = ?1 AND rc.member_id != ?1 AND m.deleted = 0 AND m.created_at_ms >= ?4 AND m.channel_id IN (` + searchMine1 + `)
) WHERE actor ` + notHidden + ` ORDER BY at DESC LIMIT ?5`

const searchMine1 = "SELECT channel_id FROM channel_members WHERE member_id = ?1"

func (s *Server) ListActivity(ctx context.Context, req *connect.Request[v1.ListActivityRequest]) (*connect.Response[v1.ListActivityResponse], error) {
	m := me(ctx)
	cutoff, err := s.retentionCutoff(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.r.QueryContext(ctx, activitySQL, m.Id, "<@"+m.Id+">", `"`+m.Id+`"`, cutoff, pageLimit(req.Msg.Limit))
	if err != nil {
		return nil, err
	}
	var items []*v1.ActivityItem
	var ids []string
	for rows.Next() {
		it := &v1.ActivityItem{Message: &v1.Message{}}
		if err := rows.Scan(&it.Message.Id, &it.Kind, &it.ActorId, &it.Emoji, &it.AtMs); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, it)
		ids = append(ids, it.Message.Id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byID, err := messagesByID(ctx, s.db.r, ids)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		it.Message = byID[it.Message.Id]
	}
	return connect.NewResponse(&v1.ListActivityResponse{Items: items}), nil
}

// threadsSQL: ?1 me, ?2 retention cutoff, ?3 limit. Unread counts replies
// from others after my thread read mark (a read_states row keyed by the
// root id) or my last post in the thread, whichever is later.
const threadsSQL = `SELECT r.id, (SELECT COUNT(*) FROM messages x WHERE x.channel_id = r.channel_id AND x.thread_root_id = r.id
		AND x.author_id != ?1 AND x.deleted = 0 AND x.author_id ` + notHidden + `
		AND x.created_seq > MAX(
			COALESCE((SELECT last_read_seq FROM read_states WHERE member_id = ?1 AND channel_id = r.id), 0),
			CASE WHEN r.author_id = ?1 THEN r.created_seq ELSE 0 END,
			COALESCE((SELECT MAX(created_seq) FROM messages y WHERE y.author_id = ?1 AND y.thread_root_id = r.id), 0)))
	FROM messages r WHERE r.thread_root_id = '' AND r.reply_count > 0 AND r.created_at_ms >= ?2
	AND r.channel_id IN (` + searchMine1 + `)
	AND (r.author_id = ?1 OR r.id IN (SELECT thread_root_id FROM messages WHERE author_id = ?1 AND thread_root_id != ''))
	ORDER BY r.last_reply_at_ms DESC LIMIT ?3`

func (s *Server) ListThreads(ctx context.Context, req *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error) {
	m := me(ctx)
	cutoff, err := s.retentionCutoff(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.r.QueryContext(ctx, threadsSQL, m.Id, cutoff, pageLimit(req.Msg.Limit))
	if err != nil {
		return nil, err
	}
	var out []*v1.ThreadSummary
	var ids []string
	for rows.Next() {
		t := &v1.ThreadSummary{Root: &v1.Message{}}
		if err := rows.Scan(&t.Root.Id, &t.UnreadCount); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, t)
		ids = append(ids, t.Root.Id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	byID, err := messagesByID(ctx, s.db.r, ids)
	if err != nil {
		return nil, err
	}
	for _, t := range out {
		t.Root = byID[t.Root.Id]
	}
	return connect.NewResponse(&v1.ListThreadsResponse{Threads: out}), nil
}

func messagesByID(ctx context.Context, q queryer, ids []string) (map[string]*v1.Message, error) {
	byID := map[string]*v1.Message{}
	if len(ids) == 0 {
		return byID, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	ms, err := queryMessages(ctx, q, "id IN (?"+strings.Repeat(",?", len(ids)-1)+")", args...)
	for _, m := range ms {
		byID[m.Id] = m
	}
	return byID, err
}

// markThreadRead stores a read mark for one thread the member can see.
// ponytail: these rows stay when the thread expires or is deleted; prune them with the thread if read_states grows.
func (s *Server) markThreadRead(ctx context.Context, member, rootID string) error {
	root, _, err := loadMessage(ctx, s.db.r, rootID, member)
	if err != nil {
		return err
	}
	if root.ThreadRootId != "" {
		return errf(connect.CodeInvalidArgument, "not a thread root")
	}
	cur, err := currentSeq(ctx, s.db.r)
	if err != nil {
		return err
	}
	return s.writeTx(ctx, func(t *wtx) error {
		_, err := t.ExecContext(ctx, `INSERT INTO read_states(member_id, channel_id, last_read_seq) VALUES (?,?,?)
			ON CONFLICT(member_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`, member, rootID, cur)
		return err
	})
}
