package server

import (
	"context"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Reports (1119): a member sends a copy of a message, with a note, to the
// moderators who outrank its author.

const (
	maxReportNote = 1000
	reportRate    = 1.0 / 600 // one every 10 minutes after the burst
	reportBurst   = 5
)

// seesReport: moderators see reports about members they outrank; the owner
// sees all, reports about the owner included, since nobody outranks them.
func seesReport(viewer, author v1.MemberRole) bool {
	return viewer == v1.MemberRole_MEMBER_ROLE_OWNER || outranks(viewer, author)
}

func (s *Server) ReportMessage(ctx context.Context, req *connect.Request[v1.ReportMessageRequest]) (*connect.Response[v1.ReportMessageResponse], error) {
	m := me(ctx)
	r := req.Msg
	if err := checkText("note", r.Note, maxReportNote, false); err != nil {
		return nil, err
	}
	if err := checkID("message_id", r.MessageId); err != nil {
		return nil, err
	}
	// Separate key from SendMessage's bucket.
	if !s.limiter.allow("report "+m.Id, reportRate, reportBurst) {
		return nil, errf(connect.CodeResourceExhausted, "you have sent many reports; try again in a few minutes")
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		msg, c, err := loadMessage(ctx, t, r.MessageId, m.Id)
		if err != nil {
			return err
		}
		if msg.Deleted {
			return errf(connect.CodeNotFound, "message not found")
		}
		if msg.AuthorId == m.Id {
			return errf(connect.CodeInvalidArgument, "you cannot report your own message")
		}
		_, err = t.ExecContext(ctx, `INSERT INTO reports(id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(message_id, reporter_id) DO UPDATE SET note = excluded.note, text = excluded.text, at_ms = excluded.at_ms`,
			newID(s.now()), msg.Id, msg.ChannelId, c.Kind == v1.ChannelKind_CHANNEL_KIND_DM, msg.AuthorId, msg.Text, msg.CreatedAtMs, msg.ThreadRootId, m.Id, r.Note, s.nowMs())
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReportMessageResponse{}), nil
}

// reports lists the open reports viewer may see, newest first.
func (s *Server) reports(ctx context.Context, q queryer, viewer *memberRow) ([]*v1.Report, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms
		FROM reports ORDER BY at_ms DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	var all []*v1.Report
	var reporters []string
	for rows.Next() {
		p := &v1.Report{Message: &v1.Message{}}
		var reporter string
		if err := rows.Scan(&p.Id, &p.Message.Id, &p.Message.ChannelId, &p.Dm, &p.Message.AuthorId, &p.Message.Text, &p.Message.CreatedAtMs,
			&p.Message.ThreadRootId, &reporter, &p.Note, &p.ReportedAtMs); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, p)
		reporters = append(reporters, reporter)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// ponytail: two member lookups per report; fine for a moderation queue of tens.
	var out []*v1.Report
	for i, p := range all {
		a, err := s.loadMember(ctx, q, "id = ?", p.Message.AuthorId)
		if err != nil {
			return nil, err
		}
		if a == nil || !seesReport(viewer.Role, a.Role) {
			continue
		}
		rp, err := s.loadMember(ctx, q, "id = ?", reporters[i])
		if err != nil {
			return nil, err
		}
		p.Author = a.Member
		if rp != nil {
			p.Reporter = rp.Member
		}
		out = append(out, p)
	}
	return out, nil
}

func (s *Server) ListReports(ctx context.Context, _ *connect.Request[v1.ListReportsRequest]) (*connect.Response[v1.ListReportsResponse], error) {
	m := me(ctx)
	if !canModerate(m) {
		return nil, errf(connect.CodePermissionDenied, "only moderators and up can see reports")
	}
	out, err := s.reports(ctx, s.db.r, m)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ListReportsResponse{Reports: out}), nil
}

func (s *Server) ResolveReport(ctx context.Context, req *connect.Request[v1.ResolveReportRequest]) (*connect.Response[v1.ResolveReportResponse], error) {
	m := me(ctx)
	if !canModerate(m) {
		return nil, errf(connect.CodePermissionDenied, "only moderators and up can resolve reports")
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		var msgID, author string
		if err := t.QueryRowContext(ctx, "SELECT message_id, author_id FROM reports WHERE id = ?", req.Msg.ReportId).Scan(&msgID, &author); err != nil {
			return errf(connect.CodeNotFound, "report not found")
		}
		a, err := s.loadMember(ctx, t, "id = ?", author)
		if err != nil {
			return err
		}
		if a == nil || !seesReport(m.Role, a.Role) {
			return errf(connect.CodeNotFound, "report not found")
		}
		_, err = t.ExecContext(ctx, "DELETE FROM reports WHERE message_id = ?", msgID)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("report resolved", "report", req.Msg.ReportId, "by", m.Id)
	return connect.NewResponse(&v1.ResolveReportResponse{}), nil
}
