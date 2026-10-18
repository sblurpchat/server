package server

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Blocking (1118). On the server a block only stops DMs between the two
// members, both ways. Clients collapse a blocked member's messages.

// dmBlocked reports whether me and any of others blocked each other.
// blocks are (blocker, blocked) pairs that involve me.
func dmBlocked(me string, others []string, blocks [][2]string) bool {
	for _, b := range blocks {
		other := b[0]
		if other == me {
			other = b[1]
		}
		if other != me && slices.Contains(others, other) {
			return true
		}
	}
	return false
}

// checkDMBlocks fails when me and any of members blocked each other.
func checkDMBlocks(ctx context.Context, q queryer, me string, members []string) error {
	rows, err := q.QueryContext(ctx, "SELECT blocker_id, blocked_id FROM blocks WHERE blocker_id = ? OR blocked_id = ?", me, me)
	if err != nil {
		return err
	}
	defer rows.Close()
	var blocks [][2]string
	for rows.Next() {
		var b [2]string
		if err := rows.Scan(&b[0], &b[1]); err != nil {
			return err
		}
		blocks = append(blocks, b)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if dmBlocked(me, members, blocks) {
		return errf(connect.CodePermissionDenied, "you cannot message this member: one of you blocked the other")
	}
	return nil
}

// blockedBy lists the members that member blocked.
func blockedBy(ctx context.Context, q queryer, member string) ([]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT blocked_id FROM blocks WHERE blocker_id = ? ORDER BY at_ms", member)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Server) BlockMember(ctx context.Context, req *connect.Request[v1.BlockMemberRequest]) (*connect.Response[v1.BlockMemberResponse], error) {
	return connect.NewResponse(&v1.BlockMemberResponse{}), s.setBlock(ctx, req.Msg.MemberId, true)
}

func (s *Server) UnblockMember(ctx context.Context, req *connect.Request[v1.UnblockMemberRequest]) (*connect.Response[v1.UnblockMemberResponse], error) {
	return connect.NewResponse(&v1.UnblockMemberResponse{}), s.setBlock(ctx, req.Msg.MemberId, false)
}

// setBlock adds or removes a block and tells the blocker's devices. Doing it
// twice is a no-op without an event.
func (s *Server) setBlock(ctx context.Context, target string, on bool) error {
	m := me(ctx)
	if err := checkID("member_id", target); err != nil {
		return err
	}
	if target == "" || target == m.Id {
		return errf(connect.CodeInvalidArgument, "pick another member to block")
	}
	return s.writeTx(ctx, func(t *wtx) error {
		q, args := "DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", []any{m.Id, target}
		if on {
			// Someone who left stays blockable: they may Join again.
			if row, err := s.loadMember(ctx, t, "id = ?", target); err != nil || row == nil {
				if err == nil {
					err = errf(connect.CodeNotFound, "member %s not found", target)
				}
				return err
			}
			q, args = "INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, at_ms) VALUES (?,?,?)", append(args, s.nowMs())
		}
		res, err := t.ExecContext(ctx, q, args...)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		ev := &v1.Event{Seq: seq, Kind: &v1.Event_MemberUnblocked{MemberUnblocked: target}}
		if on {
			ev.Kind = &v1.Event_MemberBlocked{MemberBlocked: target}
		}
		return t.emit(ev, "", m.Id)
	})
}
