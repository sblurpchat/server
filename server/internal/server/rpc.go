package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

const (
	protocolVersion = 1
	maxMessageChars = 8000
	maxNameChars    = 80
	maxTopicChars   = 500
	maxBioChars     = 500
	maxStatusChars  = 100
	maxURLChars     = 2048
	maxIDChars      = 64
	maxAttachments  = 10
	maxDMOthers     = 8
	maxEmojiPerMsg  = 50
	humanRate       = 5
	humanBurst      = 10
)

var (
	usernameRE    = regexp.MustCompile(`^[a-z0-9_.-]{2,32}$`)
	channelNameRE = regexp.MustCompile(`^[a-z0-9_-]{1,80}$`)
)

func errf(code connect.Code, format string, args ...any) error {
	return connect.NewError(code, fmt.Errorf(format, args...))
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

// checkText validates a free-text field. singleLine also rejects control
// characters such as newlines.
func checkText(field, v string, max int, singleLine bool) error {
	if !utf8.ValidString(v) {
		return errf(connect.CodeInvalidArgument, "%s is not valid UTF-8", field)
	}
	if n := utf8.RuneCountInString(v); n > max {
		return errf(connect.CodeInvalidArgument, "%s is too long (%d characters, the limit is %d)", field, n, max)
	}
	if singleLine && strings.ContainsFunc(v, unicode.IsControl) {
		return errf(connect.CodeInvalidArgument, "%s must be a single line", field)
	}
	return nil
}

func checkURL(field, v string) error {
	if v == "" {
		return nil
	}
	u, err := url.Parse(v)
	if err != nil || len(v) > maxURLChars || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return errf(connect.CodeInvalidArgument, "%s must be an http or https URL", field)
	}
	return nil
}

func checkID(field, v string) error {
	if len(v) > maxIDChars {
		return errf(connect.CodeInvalidArgument, "%s is too long", field)
	}
	return nil
}

func checkEmoji(e string) error {
	if e == "" || len(e) > 64 || !utf8.ValidString(e) || strings.ContainsFunc(e, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return errf(connect.CodeInvalidArgument, "emoji must be 1 to 64 bytes with no spaces")
	}
	return nil
}

// normalizeChannelName turns "Book Club" into "book-club".
func normalizeChannelName(name string) (string, error) {
	n := strings.Join(strings.Fields(strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "#"))), "-")
	if !channelNameRE.MatchString(n) {
		return "", errf(connect.CodeInvalidArgument, "channel names use 1 to 80 of a-z, 0-9, - and _")
	}
	return n, nil
}

// usernameBase turns a preferred username claim into a valid username, or
// "member" when nothing usable is left.
func usernameBase(pref string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(pref) {
		if r < utf8.RuneSelf && (unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("_.-", r)) {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if len(s) > 28 {
		s = s[:28]
	}
	if len(s) < 2 {
		return "member"
	}
	return s
}

// ftsQuery quotes each word so user input cannot use FTS5 syntax. The last
// word matches as a prefix, for search-as-you-type.
func ftsQuery(q string) string {
	words := strings.Fields(q)
	for i, w := range words {
		words[i] = `"` + strings.ReplaceAll(w, `"`, `""`) + `"`
	}
	if len(words) > 0 {
		words[len(words)-1] += "*"
	}
	return strings.Join(words, " ")
}

// needResync reports whether a subscriber at after cannot be caught up from
// the events kept between oldest and newest.
func needResync(after, oldest, newest int64) bool {
	if after > newest {
		return true // the server lost data or the client is confused
	}
	if after == newest {
		return false
	}
	return oldest == 0 || after < oldest-1
}

func isAdmin(m *memberRow) bool { return m.Role >= v1.MemberRole_MEMBER_ROLE_ADMIN }

func canModerate(m *memberRow) bool { return m.Role >= v1.MemberRole_MEMBER_ROLE_MODERATOR }

func canSee(c *v1.Channel, member string) bool {
	return c.Kind == v1.ChannelKind_CHANNEL_KIND_TEXT || slices.Contains(c.MemberIds, member)
}

// ---------------------------------------------------------------------------
// Loading rows
// ---------------------------------------------------------------------------

type memberRow struct {
	*v1.Member
	joinedSeq int64
}

type scanner interface{ Scan(...any) error }

const memberCols = "id, kind, role, username, display_name, avatar_url, bio, status_text, status_emoji, joined_at_ms, joined_seq"

func (s *Server) scanMember(sc scanner) (*memberRow, error) {
	m := &memberRow{Member: &v1.Member{}}
	if err := sc.Scan(&m.Id, &m.Kind, &m.Role, &m.Username, &m.DisplayName, &m.AvatarUrl, &m.Bio,
		&m.StatusText, &m.StatusEmoji, &m.JoinedAtMs, &m.joinedSeq); err != nil {
		return nil, err
	}
	m.Presence = v1.Presence_PRESENCE_OFFLINE
	if s.hub.isOnline(m.Id) {
		m.Presence = v1.Presence_PRESENCE_ONLINE
	}
	return m, nil
}

// loadMember returns nil, nil when no member matches.
func (s *Server) loadMember(ctx context.Context, q queryer, where string, args ...any) (*memberRow, error) {
	m, err := s.scanMember(q.QueryRowContext(ctx, "SELECT "+memberCols+" FROM members WHERE "+where, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

func (s *Server) listMembers(ctx context.Context, q queryer, where string, args ...any) ([]*v1.Member, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+memberCols+" FROM members WHERE "+where+" ORDER BY joined_at_ms, id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*v1.Member
	for rows.Next() {
		m, err := s.scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m.Member)
	}
	return out, rows.Err()
}

const channelCols = "id, kind, name, topic, category, position, created_at_ms, last_message_seq"

func queryChannels(ctx context.Context, q queryer, where string, args ...any) ([]*v1.Channel, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+channelCols+" FROM channels WHERE "+where+" ORDER BY category, position, name, id", args...)
	if err != nil {
		return nil, err
	}
	var out []*v1.Channel
	for rows.Next() {
		c := &v1.Channel{}
		if err := rows.Scan(&c.Id, &c.Kind, &c.Name, &c.Topic, &c.Category, &c.Position, &c.CreatedAtMs, &c.LastMessageSeq); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range out {
		if c.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
			if c.MemberIds, err = channelMemberIDs(ctx, q, c.Id); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// channelFor loads a channel the member may see. A channel they may not see
// is NOT_FOUND, so its existence does not leak.
func channelFor(ctx context.Context, q queryer, id, member string) (*v1.Channel, error) {
	cs, err := queryChannels(ctx, q, "id = ?", id)
	if err != nil {
		return nil, err
	}
	if len(cs) == 0 || !canSee(cs[0], member) {
		return nil, errf(connect.CodeNotFound, "channel not found")
	}
	return cs[0], nil
}

const messageCols = "id, channel_id, author_id, text, created_at_ms, edited_at_ms, deleted, thread_root_id, reply_count, last_reply_at_ms, client_id, seq, created_seq"

// ponytail: reactions and attachments load per message (N+1). SQLite is
// in-process so this is cheap at 200 messages; batch with IN (...) if not.
func queryMessages(ctx context.Context, q queryer, where string, args ...any) ([]*v1.Message, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+messageCols+" FROM messages WHERE "+where, args...)
	if err != nil {
		return nil, err
	}
	var out []*v1.Message
	for rows.Next() {
		m := &v1.Message{}
		if err := rows.Scan(&m.Id, &m.ChannelId, &m.AuthorId, &m.Text, &m.CreatedAtMs, &m.EditedAtMs, &m.Deleted,
			&m.ThreadRootId, &m.ReplyCount, &m.LastReplyAtMs, &m.ClientId, &m.Seq, &m.CreatedSeq); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, m := range out {
		if m.Deleted {
			continue
		}
		if m.Reactions, err = loadReactions(ctx, q, m.Id); err != nil {
			return nil, err
		}
		if m.Attachments, err = loadAttachments(ctx, q, m.Id); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func loadReactions(ctx context.Context, q queryer, msgID string) ([]*v1.Reaction, error) {
	rows, err := q.QueryContext(ctx, "SELECT emoji, member_id FROM reactions WHERE message_id = ? ORDER BY at_ms, rowid", msgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*v1.Reaction
	byEmoji := map[string]*v1.Reaction{}
	for rows.Next() {
		var emoji, member string
		if err := rows.Scan(&emoji, &member); err != nil {
			return nil, err
		}
		r := byEmoji[emoji]
		if r == nil {
			r = &v1.Reaction{Emoji: emoji}
			byEmoji[emoji] = r
			out = append(out, r)
		}
		r.MemberIds = append(r.MemberIds, member)
	}
	return out, rows.Err()
}

func loadAttachments(ctx context.Context, q queryer, msgID string) ([]*v1.Attachment, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, name, content_type, size, width, height FROM attachments WHERE message_id = ? ORDER BY created_at_ms, id", msgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*v1.Attachment
	for rows.Next() {
		a := &v1.Attachment{}
		if err := rows.Scan(&a.Id, &a.Name, &a.ContentType, &a.Size, &a.Width, &a.Height); err != nil {
			return nil, err
		}
		a.Url = fileURL(a.Id, a.Name)
		out = append(out, a)
	}
	return out, rows.Err()
}

func fileURL(id, name string) string { return "/files/" + id + "/" + url.PathEscape(name) }

// loadMessage returns NOT_FOUND unless the message exists in a channel the
// member may see.
func loadMessage(ctx context.Context, q queryer, id, member string) (*v1.Message, *v1.Channel, error) {
	ms, err := queryMessages(ctx, q, "id = ?", id)
	if err != nil {
		return nil, nil, err
	}
	if len(ms) == 0 {
		return nil, nil, errf(connect.CodeNotFound, "message not found")
	}
	c, err := channelFor(ctx, q, ms[0].ChannelId, member)
	if err != nil {
		return nil, nil, errf(connect.CodeNotFound, "message not found")
	}
	return ms[0], c, nil
}

func currentSeq(ctx context.Context, q queryer) (int64, error) {
	var seq int64
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)").Scan(&seq)
	return seq, err
}

// readState counts unread top-level messages and mentions after the
// member's last read seq (or their join, whichever is later). A mention is
// <@member_id> in the text, or any message in a DM. Own messages never count.
func readState(ctx context.Context, q queryer, m *memberRow, c *v1.Channel) (*v1.ReadState, error) {
	rs := &v1.ReadState{ChannelId: c.Id}
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT last_read_seq FROM read_states WHERE member_id = ? AND channel_id = ?), 0)", m.Id, c.Id).Scan(&rs.LastReadSeq)
	if err != nil {
		return nil, err
	}
	rs.LastReadSeq = max(rs.LastReadSeq, m.joinedSeq)
	dm := c.Kind == v1.ChannelKind_CHANNEL_KIND_DM
	err = q.QueryRowContext(ctx, `SELECT
		COUNT(*) FILTER (WHERE thread_root_id = ''),
		COUNT(*) FILTER (WHERE ? OR instr(text, ?) > 0)
		FROM messages WHERE channel_id = ? AND created_seq > ? AND author_id != ? AND deleted = 0`,
		dm, "<@"+m.Id+">", c.Id, rs.LastReadSeq, m.Id).Scan(&rs.UnreadCount, &rs.MentionCount)
	return rs, err
}

// ---------------------------------------------------------------------------
// ServerService
// ---------------------------------------------------------------------------

func (s *Server) GetServerInfo(ctx context.Context, _ *connect.Request[v1.GetServerInfoRequest]) (*connect.Response[v1.GetServerInfoResponse], error) {
	var n int32
	if err := s.db.r.QueryRowContext(ctx, "SELECT COUNT(*) FROM members WHERE deleted = 0").Scan(&n); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GetServerInfoResponse{
		Name:            s.cfg.Name,
		Description:     s.cfg.Description,
		IconUrl:         s.cfg.IconURL,
		ProtocolVersion: protocolVersion,
		TrustedIssuers:  s.cfg.TrustedIssuers,
		BaseUrl:         s.cfg.BaseURL,
		MemberCount:     n,
		AccentColor:     s.cfg.Accent,
	}), nil
}

func checkProfile(display, avatar, bio *string) error {
	if display != nil {
		if strings.TrimSpace(*display) == "" {
			return errf(connect.CodeInvalidArgument, "display_name must not be empty")
		}
		if err := checkText("display_name", *display, maxNameChars, true); err != nil {
			return err
		}
	}
	if avatar != nil {
		if err := checkURL("avatar_url", *avatar); err != nil {
			return err
		}
	}
	if bio != nil {
		return checkText("bio", *bio, maxBioChars, false)
	}
	return nil
}

func (s *Server) Join(ctx context.Context, req *connect.Request[v1.JoinRequest]) (*connect.Response[v1.JoinResponse], error) {
	id := callerFrom(ctx)
	if id.member != nil {
		return connect.NewResponse(&v1.JoinResponse{Member: id.member.Member}), nil
	}
	r := req.Msg
	display := strings.TrimSpace(r.DisplayName)
	if display == "" {
		display = usernameBase(id.username)
	}
	if err := checkProfile(&display, &r.AvatarUrl, &r.Bio); err != nil {
		return nil, err
	}
	var out *memberRow
	created := false
	err := s.writeTx(ctx, func(t *wtx) error {
		existing, err := s.loadMember(ctx, t, "iss = ? AND sub = ?", id.iss, id.sub)
		if err != nil || existing != nil {
			out = existing
			return err
		}
		base := usernameBase(id.username)
		username := base
		for n := 2; ; n++ {
			var taken bool
			if err := t.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM members WHERE username = ?)", username).Scan(&taken); err != nil {
				return err
			}
			if !taken {
				break
			}
			username = fmt.Sprintf("%s%d", base, n)
		}
		var humans int
		if err := t.QueryRowContext(ctx, "SELECT COUNT(*) FROM members WHERE iss IS NOT NULL").Scan(&humans); err != nil {
			return err
		}
		role := v1.MemberRole_MEMBER_ROLE_MEMBER
		if humans == 0 {
			role = v1.MemberRole_MEMBER_ROLE_OWNER
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		now := s.now()
		mid := newID(now)
		if _, err := t.ExecContext(ctx, `INSERT INTO members(id, kind, role, username, display_name, avatar_url, bio, joined_at_ms, joined_seq, iss, sub)
			VALUES (?,?,?,?,?,?,?,?,?,?,?)`, mid, v1.MemberKind_MEMBER_KIND_HUMAN, role, username, display, r.AvatarUrl, r.Bio,
			now.UnixMilli(), seq, id.iss, id.sub); err != nil {
			return err
		}
		if out, err = s.loadMember(ctx, t, "id = ?", mid); err != nil {
			return err
		}
		created = true
		s.log.Info("member joined", "member", mid, "role", role.String())
		return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberJoined{MemberJoined: out.Member}}, "", "")
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.JoinResponse{Member: out.Member, Created: created}), nil
}

func (s *Server) GetMe(ctx context.Context, _ *connect.Request[v1.GetMeRequest]) (*connect.Response[v1.GetMeResponse], error) {
	return connect.NewResponse(&v1.GetMeResponse{Member: me(ctx).Member}), nil
}

func (s *Server) UpdateProfile(ctx context.Context, req *connect.Request[v1.UpdateProfileRequest]) (*connect.Response[v1.UpdateProfileResponse], error) {
	r := req.Msg
	if err := checkProfile(r.DisplayName, r.AvatarUrl, r.Bio); err != nil {
		return nil, err
	}
	if r.StatusText != nil {
		if err := checkText("status_text", *r.StatusText, maxStatusChars, true); err != nil {
			return nil, err
		}
	}
	if r.StatusEmoji != nil {
		if *r.StatusEmoji != "" {
			if err := checkEmoji(*r.StatusEmoji); err != nil {
				return nil, err
			}
		}
	}
	m := me(ctx)
	var out *memberRow
	err := s.writeTx(ctx, func(t *wtx) error {
		sets := []struct {
			col string
			v   *string
		}{{"display_name", r.DisplayName}, {"avatar_url", r.AvatarUrl}, {"bio", r.Bio}, {"status_text", r.StatusText}, {"status_emoji", r.StatusEmoji}}
		for _, f := range sets {
			if f.v != nil {
				if _, err := t.ExecContext(ctx, "UPDATE members SET "+f.col+" = ? WHERE id = ?", *f.v, m.Id); err != nil {
					return err
				}
			}
		}
		var err error
		if out, err = s.loadMember(ctx, t, "id = ?", m.Id); err != nil {
			return err
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberUpdated{MemberUpdated: out.Member}}, "", "")
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.UpdateProfileResponse{Member: out.Member}), nil
}

func (s *Server) GetState(ctx context.Context, _ *connect.Request[v1.GetStateRequest]) (*connect.Response[v1.GetStateResponse], error) {
	// One read transaction is one WAL snapshot, so seq matches the data.
	tx, err := s.db.r.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	out := &v1.GetStateResponse{}
	if out.Seq, err = currentSeq(ctx, tx); err != nil {
		return nil, err
	}
	m, err := s.loadMember(ctx, tx, "id = ?", me(ctx).Id)
	if err != nil {
		return nil, err
	}
	out.Me = m.Member
	if out.Channels, err = queryChannels(ctx, tx, "kind = ? OR id IN (SELECT channel_id FROM channel_members WHERE member_id = ?)",
		v1.ChannelKind_CHANNEL_KIND_TEXT, m.Id); err != nil {
		return nil, err
	}
	if out.Members, err = s.listMembers(ctx, tx, "deleted = 0"); err != nil {
		return nil, err
	}
	for _, c := range out.Channels {
		rs, err := readState(ctx, tx, m, c)
		if err != nil {
			return nil, err
		}
		out.ReadStates = append(out.ReadStates, rs)
	}
	return connect.NewResponse(out), nil
}

// visibleEvents is the replay filter: public events, events for me, and
// events of private channels and DMs I am in.
const visibleEvents = `(scope_channel = '' AND scope_member = '') OR scope_member = ?
	OR scope_channel IN (SELECT channel_id FROM channel_members WHERE member_id = ?)`

func (s *Server) Subscribe(ctx context.Context, req *connect.Request[v1.SubscribeRequest], stream *connect.ServerStream[v1.Event]) error {
	m := me(ctx)
	// Register before reading the database: anything committed from now on
	// arrives on sb.ch, anything before is in the table. Overlap is skipped
	// by seq.
	sb := s.hub.add(m.Id)
	defer s.hub.remove(sb)

	last := req.Msg.AfterSeq
	var oldest int64
	if err := s.db.r.QueryRowContext(ctx, "SELECT COALESCE(MIN(seq), 0) FROM events").Scan(&oldest); err != nil {
		return err
	}
	newest, err := currentSeq(ctx, s.db.r)
	if err != nil {
		return err
	}
	// Send something at once: clients wait for response headers, and an
	// idle stream would otherwise send none until the first heartbeat.
	if err := stream.Send(&v1.Event{AtMs: s.nowMs(), Kind: &v1.Event_Heartbeat{Heartbeat: true}}); err != nil {
		return err
	}
	if needResync(last, oldest, newest) {
		if err := stream.Send(&v1.Event{AtMs: s.nowMs(), Kind: &v1.Event_Resync{Resync: true}}); err != nil {
			return err
		}
		last = newest
	}
	for {
		n := 0
		rows, err := s.db.r.QueryContext(ctx, "SELECT seq, payload FROM events WHERE seq > ? AND ("+visibleEvents+") ORDER BY seq LIMIT 500", last, m.Id, m.Id)
		if err != nil {
			return err
		}
		var batch []*v1.Event
		for rows.Next() {
			var payload []byte
			if err := rows.Scan(&last, &payload); err != nil {
				rows.Close()
				return err
			}
			ev := &v1.Event{}
			if err := proto.Unmarshal(payload, ev); err != nil {
				rows.Close()
				return err
			}
			batch = append(batch, ev)
			n++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, ev := range batch {
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
		if n < 500 {
			break
		}
	}

	tick := time.NewTicker(s.heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-sb.gone:
			return errf(connect.CodeResourceExhausted, "subscription fell behind; reconnect with your last seq")
		case ev := <-sb.ch:
			if ev.Seq != 0 {
				if ev.Seq <= last {
					continue
				}
				last = ev.Seq
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
		case <-tick.C:
			if err := stream.Send(&v1.Event{AtMs: s.nowMs(), Kind: &v1.Event_Heartbeat{Heartbeat: true}}); err != nil {
				return err
			}
		}
	}
}

// ---------------------------------------------------------------------------
// ChatService
// ---------------------------------------------------------------------------

func (s *Server) CreateChannel(ctx context.Context, req *connect.Request[v1.CreateChannelRequest]) (*connect.Response[v1.CreateChannelResponse], error) {
	m := me(ctx)
	if !isAdmin(m) {
		return nil, errf(connect.CodePermissionDenied, "only admins can create channels")
	}
	r := req.Msg
	name, err := normalizeChannelName(r.Name)
	if err != nil {
		return nil, err
	}
	kind := r.Kind
	switch kind {
	case v1.ChannelKind_CHANNEL_KIND_UNSPECIFIED:
		kind = v1.ChannelKind_CHANNEL_KIND_TEXT
	case v1.ChannelKind_CHANNEL_KIND_TEXT, v1.ChannelKind_CHANNEL_KIND_PRIVATE:
	default:
		return nil, errf(connect.CodeInvalidArgument, "kind must be TEXT or PRIVATE; use OpenDM for direct messages")
	}
	if err := checkText("topic", r.Topic, maxTopicChars, true); err != nil {
		return nil, err
	}
	if err := checkText("category", r.Category, maxNameChars, true); err != nil {
		return nil, err
	}
	var c *v1.Channel
	err = s.writeTx(ctx, func(t *wtx) error {
		var err error
		c, err = s.createChannel(t, kind, name, strings.TrimSpace(r.Topic), strings.TrimSpace(r.Category), "", []string{m.Id})
		return err
	})
	if isUnique(err) {
		return nil, errf(connect.CodeAlreadyExists, "a channel named %q already exists", name)
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CreateChannelResponse{Channel: c}), nil
}

// createChannel inserts a channel. members are stored for PRIVATE and DM.
func (s *Server) createChannel(t *wtx, kind v1.ChannelKind, name, topic, category, dmKey string, members []string) (*v1.Channel, error) {
	ctx := t.ctx
	var pos int32
	if err := t.QueryRowContext(ctx, "SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE category = ?", category).Scan(&pos); err != nil {
		return nil, err
	}
	now := s.now()
	id := newID(now)
	var key any
	if dmKey != "" {
		key = dmKey
	}
	if _, err := t.ExecContext(ctx, "INSERT INTO channels(id, kind, name, topic, category, position, created_at_ms, dm_key) VALUES (?,?,?,?,?,?,?,?)",
		id, kind, name, topic, category, pos, now.UnixMilli(), key); err != nil {
		return nil, err
	}
	if kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
		for _, mid := range members {
			if _, err := t.ExecContext(ctx, "INSERT OR IGNORE INTO channel_members(channel_id, member_id) VALUES (?,?)", id, mid); err != nil {
				return nil, err
			}
		}
	}
	cs, err := queryChannels(ctx, t, "id = ?", id)
	if err != nil {
		return nil, err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return nil, err
	}
	return cs[0], t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelCreated{ChannelCreated: cs[0]}}, scopeFor(kind, id), "")
}

func (s *Server) UpdateChannel(ctx context.Context, req *connect.Request[v1.UpdateChannelRequest]) (*connect.Response[v1.UpdateChannelResponse], error) {
	m := me(ctx)
	if !isAdmin(m) {
		return nil, errf(connect.CodePermissionDenied, "only admins can update channels")
	}
	r := req.Msg
	var name *string
	if r.Name != nil {
		n, err := normalizeChannelName(*r.Name)
		if err != nil {
			return nil, err
		}
		name = &n
	}
	if r.Topic != nil {
		if err := checkText("topic", *r.Topic, maxTopicChars, true); err != nil {
			return nil, err
		}
	}
	if r.Category != nil {
		if err := checkText("category", *r.Category, maxNameChars, true); err != nil {
			return nil, err
		}
	}
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		old, err := channelFor(ctx, t, r.ChannelId, m.Id)
		if err != nil {
			return err
		}
		if old.Kind == v1.ChannelKind_CHANNEL_KIND_DM {
			return errf(connect.CodeInvalidArgument, "direct messages cannot be updated")
		}
		if name != nil {
			_, err = t.ExecContext(ctx, "UPDATE channels SET name = ? WHERE id = ?", *name, old.Id)
		}
		if r.Topic != nil && err == nil {
			_, err = t.ExecContext(ctx, "UPDATE channels SET topic = ? WHERE id = ?", strings.TrimSpace(*r.Topic), old.Id)
		}
		if r.Category != nil && err == nil {
			_, err = t.ExecContext(ctx, "UPDATE channels SET category = ? WHERE id = ?", strings.TrimSpace(*r.Category), old.Id)
		}
		if r.Position != nil && err == nil {
			_, err = t.ExecContext(ctx, "UPDATE channels SET position = ? WHERE id = ?", *r.Position, old.Id)
		}
		if err != nil {
			return err
		}
		if c, err = channelFor(ctx, t, old.Id, m.Id); err != nil {
			return err
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelUpdated{ChannelUpdated: c}}, scopeFor(c.Kind, c.Id), "")
	})
	if isUnique(err) {
		return nil, errf(connect.CodeAlreadyExists, "a channel with that name already exists")
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.UpdateChannelResponse{Channel: c}), nil
}

func (s *Server) OpenDM(ctx context.Context, req *connect.Request[v1.OpenDMRequest]) (*connect.Response[v1.OpenDMResponse], error) {
	m := me(ctx)
	ids := []string{m.Id}
	for _, id := range req.Msg.MemberIds {
		if err := checkID("member_ids", id); err != nil {
			return nil, err
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) < 2 || len(ids) > maxDMOthers+1 {
		return nil, errf(connect.CodeInvalidArgument, "a DM needs 1 to %d other members", maxDMOthers)
	}
	slices.Sort(ids)
	key := strings.Join(ids, ",")
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		existing, err := queryChannels(ctx, t, "dm_key = ?", key)
		if err != nil {
			return err
		}
		if len(existing) > 0 {
			c = existing[0]
			return nil
		}
		for _, id := range ids {
			var ok bool
			if err := t.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM members WHERE id = ? AND deleted = 0)", id).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return errf(connect.CodeNotFound, "member %s not found", id)
			}
		}
		c, err = s.createChannel(t, v1.ChannelKind_CHANNEL_KIND_DM, "", "", "", key, ids)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.OpenDMResponse{Channel: c}), nil
}

func (s *Server) ListMessages(ctx context.Context, req *connect.Request[v1.ListMessagesRequest]) (*connect.Response[v1.ListMessagesResponse], error) {
	m := me(ctx)
	r := req.Msg
	if err := checkID("thread_root_id", r.ThreadRootId); err != nil {
		return nil, err
	}
	if _, err := channelFor(ctx, s.db.r, r.ChannelId, m.Id); err != nil {
		return nil, err
	}
	limit := int(r.Limit)
	if limit <= 0 {
		limit = 50
	}
	limit = min(limit, 200)
	before := int64(math.MaxInt64)
	if r.BeforeId != "" {
		err := s.db.r.QueryRowContext(ctx, "SELECT created_seq FROM messages WHERE id = ? AND channel_id = ?", r.BeforeId, r.ChannelId).Scan(&before)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errf(connect.CodeInvalidArgument, "before_id is not a message in this channel")
		} else if err != nil {
			return nil, err
		}
	}
	ms, err := queryMessages(ctx, s.db.r, `channel_id = ? AND thread_root_id = ? AND created_seq < ? AND (deleted = 0 OR reply_count > 0)
		ORDER BY created_seq DESC LIMIT ?`, r.ChannelId, r.ThreadRootId, before, limit+1)
	if err != nil {
		return nil, err
	}
	out := &v1.ListMessagesResponse{HasMore: len(ms) > limit}
	if out.HasMore {
		ms = ms[:limit]
	}
	slices.Reverse(ms)
	out.Messages = ms
	return connect.NewResponse(out), nil
}

func (s *Server) SendMessage(ctx context.Context, req *connect.Request[v1.SendMessageRequest]) (*connect.Response[v1.SendMessageResponse], error) {
	m := me(ctx)
	r := req.Msg
	if strings.TrimSpace(r.Text) == "" && len(r.AttachmentIds) == 0 {
		return nil, errf(connect.CodeInvalidArgument, "message is empty")
	}
	if err := checkText("text", r.Text, maxMessageChars, false); err != nil {
		return nil, err
	}
	for _, f := range [][2]string{{"client_id", r.ClientId}, {"thread_root_id", r.ThreadRootId}} {
		if err := checkID(f[0], f[1]); err != nil {
			return nil, err
		}
	}
	if len(r.AttachmentIds) > maxAttachments {
		return nil, errf(connect.CodeInvalidArgument, "at most %d attachments per message", maxAttachments)
	}
	rate, burst := float64(humanRate), humanBurst
	if m.Kind == v1.MemberKind_MEMBER_KIND_BOT {
		rate, burst = s.cfg.BotRate, s.cfg.BotBurst
	}
	if !s.limiter.allow(m.Id, rate, burst) {
		return nil, errf(connect.CodeResourceExhausted, "you are sending messages too fast")
	}
	var out *v1.Message
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		out, err = s.sendMessage(t, m.Id, r, s.now())
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.SendMessageResponse{Message: out}), nil
}

// sendMessage stores a message and emits its events. Seeding uses it too,
// with past timestamps.
func (s *Server) sendMessage(t *wtx, author string, r *v1.SendMessageRequest, at time.Time) (*v1.Message, error) {
	ctx := t.ctx
	if r.ClientId != "" {
		existing, err := queryMessages(ctx, t, "author_id = ? AND client_id = ?", author, r.ClientId)
		if err != nil || len(existing) > 0 {
			if err == nil {
				return existing[0], nil
			}
			return nil, err
		}
	}
	c, err := channelFor(ctx, t, r.ChannelId, author)
	if err != nil {
		return nil, err
	}
	var root *v1.Message
	if r.ThreadRootId != "" {
		roots, err := queryMessages(ctx, t, "id = ? AND channel_id = ?", r.ThreadRootId, c.Id)
		if err != nil {
			return nil, err
		}
		if len(roots) == 0 || roots[0].Deleted {
			return nil, errf(connect.CodeNotFound, "thread not found")
		}
		if roots[0].ThreadRootId != "" {
			return nil, errf(connect.CodeInvalidArgument, "cannot start a thread on a thread reply")
		}
		root = roots[0]
	}
	seq, err := t.nextSeq()
	if err != nil {
		return nil, err
	}
	id := newID(at)
	if _, err := t.ExecContext(ctx, `INSERT INTO messages(id, channel_id, author_id, text, created_at_ms, thread_root_id, client_id, created_seq, seq)
		VALUES (?,?,?,?,?,?,?,?,?)`, id, c.Id, author, r.Text, at.UnixMilli(), r.ThreadRootId, r.ClientId, seq, seq); err != nil {
		return nil, err
	}
	for _, aid := range r.AttachmentIds {
		res, err := t.ExecContext(ctx, "UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL", id, aid, author)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, errf(connect.CodeInvalidArgument, "attachment %s is not an unused upload of yours", aid)
		}
	}
	if root == nil {
		if _, err := t.ExecContext(ctx, "UPDATE channels SET last_message_seq = ? WHERE id = ?", seq, c.Id); err != nil {
			return nil, err
		}
	}
	ms, err := queryMessages(ctx, t, "id = ?", id)
	if err != nil {
		return nil, err
	}
	scope := scopeFor(c.Kind, c.Id)
	if err := t.emit(&v1.Event{Seq: seq, AtMs: at.UnixMilli(), Kind: &v1.Event_MessageCreated{MessageCreated: ms[0]}}, scope, ""); err != nil {
		return nil, err
	}
	if root != nil {
		if _, err := t.ExecContext(ctx, "UPDATE messages SET reply_count = reply_count + 1, last_reply_at_ms = ? WHERE id = ?", at.UnixMilli(), root.Id); err != nil {
			return nil, err
		}
		if err := s.emitMessageUpdated(t, root.Id, scope, at.UnixMilli()); err != nil {
			return nil, err
		}
	}
	return ms[0], nil
}

// emitMessageUpdated bumps the message's seq and emits message_updated.
func (s *Server) emitMessageUpdated(t *wtx, id, scope string, at int64) error {
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	if _, err := t.ExecContext(t.ctx, "UPDATE messages SET seq = ? WHERE id = ?", seq, id); err != nil {
		return err
	}
	ms, err := queryMessages(t.ctx, t, "id = ?", id)
	if err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, AtMs: at, Kind: &v1.Event_MessageUpdated{MessageUpdated: ms[0]}}, scope, "")
}

func (s *Server) EditMessage(ctx context.Context, req *connect.Request[v1.EditMessageRequest]) (*connect.Response[v1.EditMessageResponse], error) {
	m := me(ctx)
	r := req.Msg
	if err := checkText("text", r.Text, maxMessageChars, false); err != nil {
		return nil, err
	}
	var out *v1.Message
	err := s.writeTx(ctx, func(t *wtx) error {
		msg, c, err := loadMessage(ctx, t, r.MessageId, m.Id)
		if err != nil {
			return err
		}
		if msg.Deleted {
			return errf(connect.CodeNotFound, "message not found")
		}
		if msg.AuthorId != m.Id {
			return errf(connect.CodePermissionDenied, "you can only edit your own messages")
		}
		if strings.TrimSpace(r.Text) == "" && len(msg.Attachments) == 0 {
			return errf(connect.CodeInvalidArgument, "message is empty; delete it instead")
		}
		if r.Text == msg.Text {
			out = msg
			return nil
		}
		now := s.nowMs()
		if _, err := t.ExecContext(ctx, "UPDATE messages SET text = ?, edited_at_ms = ? WHERE id = ?", r.Text, now, msg.Id); err != nil {
			return err
		}
		if err := s.emitMessageUpdated(t, msg.Id, scopeFor(c.Kind, c.Id), now); err != nil {
			return err
		}
		out, _, err = loadMessage(ctx, t, msg.Id, m.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.EditMessageResponse{Message: out}), nil
}

func (s *Server) DeleteMessage(ctx context.Context, req *connect.Request[v1.DeleteMessageRequest]) (*connect.Response[v1.DeleteMessageResponse], error) {
	m := me(ctx)
	var files []string
	err := s.writeTx(ctx, func(t *wtx) error {
		msg, c, err := loadMessage(ctx, t, req.Msg.MessageId, m.Id)
		if err != nil {
			return err
		}
		if msg.Deleted {
			return nil
		}
		if msg.AuthorId != m.Id && !canModerate(m) {
			return errf(connect.CodePermissionDenied, "you can only delete your own messages")
		}
		for _, a := range msg.Attachments {
			files = append(files, a.Id)
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "UPDATE messages SET deleted = 1, text = '', seq = ? WHERE id = ?", seq, msg.Id); err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "DELETE FROM reactions WHERE message_id = ?", msg.Id); err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "DELETE FROM attachments WHERE message_id = ?", msg.Id); err != nil {
			return err
		}
		now := s.nowMs()
		scope := scopeFor(c.Kind, c.Id)
		gone := &v1.Message{Id: msg.Id, ChannelId: msg.ChannelId, AuthorId: msg.AuthorId, CreatedAtMs: msg.CreatedAtMs,
			Deleted: true, ThreadRootId: msg.ThreadRootId, ReplyCount: msg.ReplyCount, Seq: seq, CreatedSeq: msg.CreatedSeq}
		if err := t.emit(&v1.Event{Seq: seq, AtMs: now, Kind: &v1.Event_MessageDeleted{MessageDeleted: gone}}, scope, ""); err != nil {
			return err
		}
		if msg.ThreadRootId != "" {
			if _, err := t.ExecContext(ctx, "UPDATE messages SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?", msg.ThreadRootId); err != nil {
				return err
			}
			return s.emitMessageUpdated(t, msg.ThreadRootId, scope, now)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, id := range files {
		os.Remove(filepath.Join(s.filesDir, id))
	}
	return connect.NewResponse(&v1.DeleteMessageResponse{}), nil
}

func (s *Server) React(ctx context.Context, req *connect.Request[v1.ReactRequest]) (*connect.Response[v1.ReactResponse], error) {
	m := me(ctx)
	r := req.Msg
	if err := checkEmoji(r.Emoji); err != nil {
		return nil, err
	}
	var out *v1.Message
	err := s.writeTx(ctx, func(t *wtx) error {
		msg, c, err := loadMessage(ctx, t, r.MessageId, m.Id)
		if err != nil {
			return err
		}
		if msg.Deleted {
			return errf(connect.CodeNotFound, "message not found")
		}
		var res sql.Result
		if r.Remove {
			res, err = t.ExecContext(ctx, "DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND member_id = ?", msg.Id, r.Emoji, m.Id)
		} else {
			if len(msg.Reactions) >= maxEmojiPerMsg && !slices.ContainsFunc(msg.Reactions, func(x *v1.Reaction) bool { return x.Emoji == r.Emoji }) {
				return errf(connect.CodeResourceExhausted, "this message has too many different reactions")
			}
			res, err = t.ExecContext(ctx, "INSERT OR IGNORE INTO reactions(message_id, emoji, member_id, at_ms) VALUES (?,?,?,?)", msg.Id, r.Emoji, m.Id, s.nowMs())
		}
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			out = msg // no change, no event
			return nil
		}
		if err := s.emitMessageUpdated(t, msg.Id, scopeFor(c.Kind, c.Id), s.nowMs()); err != nil {
			return err
		}
		out, _, err = loadMessage(ctx, t, msg.Id, m.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ReactResponse{Message: out}), nil
}

func (s *Server) MarkRead(ctx context.Context, req *connect.Request[v1.MarkReadRequest]) (*connect.Response[v1.MarkReadResponse], error) {
	m := me(ctx)
	r := req.Msg
	var rs *v1.ReadState
	err := s.writeTx(ctx, func(t *wtx) error {
		c, err := channelFor(ctx, t, r.ChannelId, m.Id)
		if err != nil {
			return err
		}
		cur, err := currentSeq(ctx, t)
		if err != nil {
			return err
		}
		seq := r.Seq
		if seq <= 0 || seq > cur {
			seq = cur
		}
		if _, err := t.ExecContext(ctx, `INSERT INTO read_states(member_id, channel_id, last_read_seq) VALUES (?,?,?)
			ON CONFLICT(member_id, channel_id) DO UPDATE SET last_read_seq = excluded.last_read_seq`, m.Id, c.Id, seq); err != nil {
			return err
		}
		if rs, err = readState(ctx, t, m, c); err != nil {
			return err
		}
		evSeq, err := t.nextSeq()
		if err != nil {
			return err
		}
		return t.emit(&v1.Event{Seq: evSeq, Kind: &v1.Event_ReadState{ReadState: rs}}, "", m.Id)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.MarkReadResponse{ReadState: rs}), nil
}

func (s *Server) SetTyping(ctx context.Context, req *connect.Request[v1.SetTypingRequest]) (*connect.Response[v1.SetTypingResponse], error) {
	m := me(ctx)
	r := req.Msg
	if err := checkID("thread_root_id", r.ThreadRootId); err != nil {
		return nil, err
	}
	c, err := channelFor(ctx, s.db.r, r.ChannelId, m.Id)
	if err != nil {
		return nil, err
	}
	var aud map[string]bool
	if c.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
		aud = map[string]bool{}
		for _, id := range c.MemberIds {
			aud[id] = true
		}
	}
	s.hub.publish(&v1.Event{AtMs: s.nowMs(), Kind: &v1.Event_Typing{Typing: &v1.TypingEvent{
		ChannelId: c.Id, MemberId: m.Id, ThreadRootId: r.ThreadRootId}}}, aud)
	return connect.NewResponse(&v1.SetTypingResponse{}), nil
}

func (s *Server) Search(ctx context.Context, req *connect.Request[v1.SearchRequest]) (*connect.Response[v1.SearchResponse], error) {
	m := me(ctx)
	r := req.Msg
	q := strings.TrimSpace(r.Query)
	if q == "" {
		return nil, errf(connect.CodeInvalidArgument, "query is empty")
	}
	if err := checkText("query", q, 200, true); err != nil {
		return nil, err
	}
	limit := int(r.Limit)
	if limit <= 0 {
		limit = 20
	}
	limit = min(limit, 100)
	where := `n IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) AND deleted = 0
		AND (channel_id IN (SELECT id FROM channels WHERE kind = ?) OR channel_id IN (SELECT channel_id FROM channel_members WHERE member_id = ?))`
	args := []any{ftsQuery(q), v1.ChannelKind_CHANNEL_KIND_TEXT, m.Id}
	if r.ChannelId != "" {
		if _, err := channelFor(ctx, s.db.r, r.ChannelId, m.Id); err != nil {
			return nil, err
		}
		where += " AND channel_id = ?"
		args = append(args, r.ChannelId)
	}
	ms, err := queryMessages(ctx, s.db.r, where+" ORDER BY created_seq DESC LIMIT ?", append(args, limit)...)
	if err != nil {
		if strings.Contains(err.Error(), "fts5") {
			return nil, errf(connect.CodeInvalidArgument, "cannot search for that")
		}
		return nil, err
	}
	return connect.NewResponse(&v1.SearchResponse{Messages: ms}), nil
}

// ---------------------------------------------------------------------------
// BotService
// ---------------------------------------------------------------------------

func (s *Server) CreateBot(ctx context.Context, req *connect.Request[v1.CreateBotRequest]) (*connect.Response[v1.CreateBotResponse], error) {
	m := me(ctx)
	if !isAdmin(m) {
		return nil, errf(connect.CodePermissionDenied, "only admins can create bots")
	}
	r := req.Msg
	username := strings.ToLower(strings.TrimSpace(r.Username))
	if !usernameRE.MatchString(username) {
		return nil, errf(connect.CodeInvalidArgument, "usernames use 2 to 32 of a-z, 0-9, _, . and -")
	}
	display := strings.TrimSpace(r.DisplayName)
	if display == "" {
		display = username
	}
	if err := checkProfile(&display, &r.AvatarUrl, &r.Bio); err != nil {
		return nil, err
	}
	var bot *memberRow
	var token string
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		bot, token, err = s.createBot(t, username, display, r.AvatarUrl, r.Bio, s.now())
		return err
	})
	if isUnique(err) {
		return nil, errf(connect.CodeAlreadyExists, "username %q is taken", username)
	}
	if err != nil {
		return nil, err
	}
	s.log.Info("bot created", "bot", bot.Id, "by", m.Id)
	return connect.NewResponse(&v1.CreateBotResponse{Bot: bot.Member, Token: token}), nil
}

func (s *Server) createBot(t *wtx, username, display, avatar, bio string, at time.Time) (*memberRow, string, error) {
	token, hash := newBotToken()
	seq, err := t.nextSeq()
	if err != nil {
		return nil, "", err
	}
	id := newID(at)
	if _, err := t.ExecContext(t.ctx, `INSERT INTO members(id, kind, role, username, display_name, avatar_url, bio, joined_at_ms, joined_seq, token_hash)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, id, v1.MemberKind_MEMBER_KIND_BOT, v1.MemberRole_MEMBER_ROLE_MEMBER, username, display, avatar, bio,
		at.UnixMilli(), seq, hash); err != nil {
		return nil, "", err
	}
	bot, err := s.loadMember(t.ctx, t, "id = ?", id)
	if err != nil {
		return nil, "", err
	}
	return bot, token, t.emit(&v1.Event{Seq: seq, AtMs: at.UnixMilli(), Kind: &v1.Event_MemberJoined{MemberJoined: bot.Member}}, "", "")
}

func (s *Server) ListBots(ctx context.Context, _ *connect.Request[v1.ListBotsRequest]) (*connect.Response[v1.ListBotsResponse], error) {
	bots, err := s.listMembers(ctx, s.db.r, "kind = ? AND deleted = 0", v1.MemberKind_MEMBER_KIND_BOT)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ListBotsResponse{Bots: bots}), nil
}

// botFor loads a live bot for an admin action.
func (s *Server) botFor(ctx context.Context, q queryer, botID string) (*memberRow, error) {
	if !isAdmin(me(ctx)) {
		return nil, errf(connect.CodePermissionDenied, "only admins can manage bots")
	}
	bot, err := s.loadMember(ctx, q, "id = ? AND kind = ? AND deleted = 0", botID, v1.MemberKind_MEMBER_KIND_BOT)
	if err == nil && bot == nil {
		err = errf(connect.CodeNotFound, "bot not found")
	}
	return bot, err
}

func (s *Server) RotateBotToken(ctx context.Context, req *connect.Request[v1.RotateBotTokenRequest]) (*connect.Response[v1.RotateBotTokenResponse], error) {
	var token string
	err := s.writeTx(ctx, func(t *wtx) error {
		bot, err := s.botFor(ctx, t, req.Msg.BotId)
		if err != nil {
			return err
		}
		var hash string
		token, hash = newBotToken()
		_, err = t.ExecContext(ctx, "UPDATE members SET token_hash = ? WHERE id = ?", hash, bot.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RotateBotTokenResponse{Token: token}), nil
}

func (s *Server) DeleteBot(ctx context.Context, req *connect.Request[v1.DeleteBotRequest]) (*connect.Response[v1.DeleteBotResponse], error) {
	err := s.writeTx(ctx, func(t *wtx) error {
		bot, err := s.botFor(ctx, t, req.Msg.BotId)
		if err != nil {
			return err
		}
		// Keep the row so old messages still have an author.
		if _, err := t.ExecContext(ctx, "UPDATE members SET deleted = 1, token_hash = NULL WHERE id = ?", bot.Id); err != nil {
			return err
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberLeft{MemberLeft: bot.Id}}, "", "")
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeleteBotResponse{}), nil
}
