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

// Muting (1293) shares the code: a mutes row only drops the muted member's
// messages from the muter's unread counts (see unreadCounts).
type relation struct{ table, by, target, verb string }

var (
	blockRel = relation{"blocks", "blocker_id", "blocked_id", "block"}
	muteRel  = relation{"mutes", "muter_id", "muted_id", "mute"}
)

// listRel lists the members that member blocked or muted.
func listRel(ctx context.Context, q queryer, r relation, member string) ([]string, error) {
	return scanIDs(q.QueryContext(ctx, "SELECT "+r.target+" FROM "+r.table+" WHERE "+r.by+" = ? ORDER BY at_ms", member))
}

func (s *Server) BlockMember(ctx context.Context, req *connect.Request[v1.BlockMemberRequest]) (*connect.Response[v1.BlockMemberResponse], error) {
	return connect.NewResponse(&v1.BlockMemberResponse{}), s.setRel(ctx, blockRel, req.Msg.MemberId, true)
}

func (s *Server) UnblockMember(ctx context.Context, req *connect.Request[v1.UnblockMemberRequest]) (*connect.Response[v1.UnblockMemberResponse], error) {
	return connect.NewResponse(&v1.UnblockMemberResponse{}), s.setRel(ctx, blockRel, req.Msg.MemberId, false)
}

func (s *Server) MuteMember(ctx context.Context, req *connect.Request[v1.MuteMemberRequest]) (*connect.Response[v1.MuteMemberResponse], error) {
	return connect.NewResponse(&v1.MuteMemberResponse{}), s.setRel(ctx, muteRel, req.Msg.MemberId, true)
}

func (s *Server) UnmuteMember(ctx context.Context, req *connect.Request[v1.UnmuteMemberRequest]) (*connect.Response[v1.UnmuteMemberResponse], error) {
	return connect.NewResponse(&v1.UnmuteMemberResponse{}), s.setRel(ctx, muteRel, req.Msg.MemberId, false)
}

// setRel adds or removes a block or mute and tells only the caller's
// devices. Doing it twice is a no-op without an event.
func (s *Server) setRel(ctx context.Context, r relation, target string, on bool) error {
	m := me(ctx)
	if err := checkID("member_id", target); err != nil {
		return err
	}
	if target == "" || target == m.Id {
		return errf(connect.CodeInvalidArgument, "pick another member to %s", r.verb)
	}
	return s.writeTx(ctx, func(t *wtx) error {
		q, args := "DELETE FROM "+r.table+" WHERE "+r.by+" = ? AND "+r.target+" = ?", []any{m.Id, target}
		if on {
			// Someone who left stays blockable and mutable: they may Join again.
			if row, err := s.loadMember(ctx, t, "id = ?", target); err != nil || row == nil {
				if err == nil {
					err = errf(connect.CodeNotFound, "member %s not found", target)
				}
				return err
			}
			q, args = "INSERT OR IGNORE INTO "+r.table+"("+r.by+", "+r.target+", at_ms) VALUES (?,?,?)", append(args, s.nowMs())
		}
		res, err := t.ExecContext(ctx, q, args...)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		ev := &v1.Event{}
		switch {
		case r == blockRel && on:
			ev.Kind = &v1.Event_MemberBlocked{MemberBlocked: target}
		case r == blockRel:
			ev.Kind = &v1.Event_MemberUnblocked{MemberUnblocked: target}
		case on:
			ev.Kind = &v1.Event_MemberMuted{MemberMuted: target}
		default:
			ev.Kind = &v1.Event_MemberUnmuted{MemberUnmuted: target}
		}
		return t.emit(ev, "", m.Id)
	})
}
