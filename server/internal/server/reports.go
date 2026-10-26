package server

import (
	"context"
	"encoding/json"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Reports (1119): a member sends a copy of a message, with a note, to the
// moderators who outrank its author. The copy keeps the message's files while
// the report is open (1256); resolving keeps the report as a log entry with
// who resolved it (1257); moderators get their open count (1255).

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
	if err := s.checkReport(m.Id, "message_id", r.MessageId, r.Note); err != nil {
		return nil, err
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
		files := []string{}
		for _, a := range msg.Attachments {
			files = append(files, a.Id)
		}
		ids, _ := json.Marshal(files)
		_, err = t.ExecContext(ctx, `INSERT INTO reports(id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms, attachment_ids)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(message_id, author_id, reporter_id) WHERE resolved_at_ms = 0
			DO UPDATE SET note = excluded.note, text = excluded.text, at_ms = excluded.at_ms, attachment_ids = excluded.attachment_ids`,
			newID(s.now()), msg.Id, msg.ChannelId, c.Kind == v1.ChannelKind_CHANNEL_KIND_DM, msg.AuthorId, msg.Text, msg.CreatedAtMs, msg.ThreadRootId, m.Id, r.Note, s.nowMs(), string(ids))
		if err != nil {
			return err
		}
		return s.emitReportCounts(t)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReportMessageResponse{}), nil
}

// checkReport validates a report's target id and note, then spends a token
// from the reporter's own bucket (separate from SendMessage's).
func (s *Server) checkReport(reporter, field, id, note string) error {
	if err := checkText("note", note, maxReportNote, false); err != nil {
		return err
	}
	if err := checkID(field, id); err != nil {
		return err
	}
	if !s.limiter.allow("report "+reporter, reportRate, reportBurst) {
		return errf(connect.CodeResourceExhausted, "you have sent many reports; try again in a few minutes")
	}
	return nil
}

// ReportMember (1507) stores a report with no message: message_id is '' and
// author_id is the reported member.
func (s *Server) ReportMember(ctx context.Context, req *connect.Request[v1.ReportMemberRequest]) (*connect.Response[v1.ReportMemberResponse], error) {
	m := me(ctx)
	r := req.Msg
	if r.MemberId == m.Id {
		return nil, errf(connect.CodeInvalidArgument, "you cannot report yourself")
	}
	if err := s.checkReport(m.Id, "member_id", r.MemberId, r.Note); err != nil {
		return nil, err
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		if row, err := s.loadMember(ctx, t, "id = ?", r.MemberId); err != nil || row == nil {
			if err == nil {
				err = errf(connect.CodeNotFound, "member not found")
			}
			return err
		}
		_, err := t.ExecContext(ctx, `INSERT INTO reports(id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms)
			VALUES (?,'','',0,?,'',0,'',?,?,?)
			ON CONFLICT(message_id, author_id, reporter_id) WHERE resolved_at_ms = 0
			DO UPDATE SET note = excluded.note, at_ms = excluded.at_ms`,
			newID(s.now()), r.MemberId, m.Id, r.Note, s.nowMs())
		if err != nil {
			return err
		}
		return s.emitReportCounts(t)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReportMemberResponse{}), nil
}

// reports lists the reports a viewer with this role may see: open ones
// newest first, or resolved ones newest resolution first.
func (s *Server) reports(ctx context.Context, q queryer, viewer v1.MemberRole, resolved bool) ([]*v1.Report, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, message_id, channel_id, dm, author_id, text, created_at_ms, thread_root_id, reporter_id, note, at_ms,
		attachment_ids, resolved_by, resolved_at_ms
		FROM reports WHERE (resolved_at_ms != 0) = ? ORDER BY resolved_at_ms DESC, at_ms DESC, id DESC`, resolved)
	if err != nil {
		return nil, err
	}
	type extra struct{ author, reporter, files, resolver string }
	var all []*v1.Report
	var more []extra
	for rows.Next() {
		p := &v1.Report{Message: &v1.Message{}}
		var x extra
		if err := rows.Scan(&p.Id, &p.Message.Id, &p.Message.ChannelId, &p.Dm, &p.Message.AuthorId, &p.Message.Text, &p.Message.CreatedAtMs,
			&p.Message.ThreadRootId, &x.reporter, &p.Note, &p.ReportedAtMs, &x.files, &x.resolver, &p.ResolvedAtMs); err != nil {
			rows.Close()
			return nil, err
		}
		x.author = p.Message.AuthorId
		if p.Message.Id == "" {
			p.Message = nil // a member report (1507)
		}
		all = append(all, p)
		more = append(more, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// ponytail: a few lookups per report; fine for a moderation queue of tens.
	var out []*v1.Report
	for i, p := range all {
		a, err := s.loadMember(ctx, q, "id = ?", more[i].author)
		if err != nil {
			return nil, err
		}
		if a == nil || !seesReport(viewer, a.Role) {
			continue
		}
		p.Author = a.Member
		if p.Reporter, err = s.memberOrNil(ctx, q, more[i].reporter); err != nil {
			return nil, err
		}
		if p.ResolvedBy, err = s.memberOrNil(ctx, q, more[i].resolver); err != nil {
			return nil, err
		}
		var files []string
		json.Unmarshal([]byte(more[i].files), &files)
		for _, id := range files {
			f, err := loadAttachment(ctx, q, id)
			if err != nil {
				return nil, err
			}
			if f != nil {
				p.Message.Attachments = append(p.Message.Attachments, f)
			}
		}
		out = append(out, p)
	}
	return out, nil
}

// memberOrNil loads a member by id; nil for "" or someone gone.
func (s *Server) memberOrNil(ctx context.Context, q queryer, id string) (*v1.Member, error) {
	if id == "" {
		return nil, nil
	}
	m, err := s.loadMember(ctx, q, "id = ?", id)
	if m == nil || err != nil {
		return nil, err
	}
	return m.Member, nil
}

// openReports counts the open reports a viewer with this role may see.
func (s *Server) openReports(ctx context.Context, q queryer, viewer v1.MemberRole) (int32, error) {
	if viewer < v1.MemberRole_MEMBER_ROLE_MODERATOR {
		return 0, nil
	}
	ps, err := s.reports(ctx, q, viewer, false)
	return int32(len(ps)), err
}

// emitReportCounts sends each moderator their open report count (1255).
// ponytail: recounts the queue per moderator; fine for tens of reports and a few moderators.
func (s *Server) emitReportCounts(t *wtx) error {
	mods, err := s.listMembers(t.ctx, t, "deleted = 0 AND role >= ?", int32(v1.MemberRole_MEMBER_ROLE_MODERATOR))
	if err != nil {
		return err
	}
	for _, m := range mods {
		n, err := s.openReports(t.ctx, t, m.Role)
		if err != nil {
			return err
		}
		if err := t.emit(&v1.Event{Kind: &v1.Event_OpenReports{OpenReports: n}}, "", m.Id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) ListReports(ctx context.Context, req *connect.Request[v1.ListReportsRequest]) (*connect.Response[v1.ListReportsResponse], error) {
	m := me(ctx)
	if !canModerate(m) {
		return nil, errf(connect.CodePermissionDenied, "only moderators and up can see reports")
	}
	out, err := s.reports(ctx, s.db.r, m.Role, req.Msg.Resolved)
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
		if err := t.QueryRowContext(ctx, "SELECT message_id, author_id FROM reports WHERE id = ? AND resolved_at_ms = 0", req.Msg.ReportId).Scan(&msgID, &author); err != nil {
			return errf(connect.CodeNotFound, "report not found")
		}
		a, err := s.loadMember(ctx, t, "id = ?", author)
		if err != nil {
			return err
		}
		if a == nil || !seesReport(m.Role, a.Role) {
			return errf(connect.CodeNotFound, "report not found")
		}
		if _, err = t.ExecContext(ctx, "UPDATE reports SET resolved_by = ?, resolved_at_ms = ? WHERE message_id = ? AND author_id = ? AND resolved_at_ms = 0",
			m.Id, s.nowMs(), msgID, author); err != nil {
			return err
		}
		return s.emitReportCounts(t)
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("report resolved", "report", req.Msg.ReportId, "by", m.Id)
	return connect.NewResponse(&v1.ResolveReportResponse{}), nil
}
