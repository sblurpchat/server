package server

import (
	"cmp"
	"context"
	"crypto/rand"
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
	protocolVersion     = 1
	maxMessageChars     = 8000
	maxNameChars        = 80
	maxTopicChars       = 500
	maxDescriptionChars = 2000
	maxBioChars         = 500
	maxStatusChars      = 100
	maxURLChars         = 2048
	maxIDChars          = 64
	maxAttachments      = 10
	maxDMOthers         = 8
	maxEmojiPerMsg      = 50
	humanRate           = 5
	humanBurst          = 10
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

// outranks reports whether actor may act on target: moderator or higher and
// a strictly higher role. Owner > admin > moderator > member.
func outranks(actor, target v1.MemberRole) bool {
	return actor >= v1.MemberRole_MEMBER_ROLE_MODERATOR && actor > target
}

// ---------------------------------------------------------------------------
// Loading rows
// ---------------------------------------------------------------------------

type memberRow struct {
	*v1.Member
	joinedSeq int64
	claim     string // username_claim
}

type scanner interface{ Scan(...any) error }

const memberCols = "id, kind, role, username, display_name, avatar_url, bio, status_text, status_emoji, joined_at_ms, joined_seq, username_claim, (SELECT group_concat(role_id) FROM member_roles WHERE member_id = members.id)"

func (s *Server) scanMember(sc scanner) (*memberRow, error) {
	m := &memberRow{Member: &v1.Member{}}
	var roles sql.NullString
	if err := sc.Scan(&m.Id, &m.Kind, &m.Role, &m.Username, &m.DisplayName, &m.AvatarUrl, &m.Bio,
		&m.StatusText, &m.StatusEmoji, &m.JoinedAtMs, &m.joinedSeq, &m.claim, &roles); err != nil {
		return nil, err
	}
	m.RoleIds = splitIDs(roles)
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

const channelCols = "id, kind, name, topic, category, position, created_at_ms, last_message_seq, is_default, (SELECT group_concat(role_id) FROM channel_roles WHERE channel_id = channels.id), header_image_id"

func queryChannels(ctx context.Context, q queryer, where string, args ...any) ([]*v1.Channel, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+channelCols+" FROM channels WHERE "+where+" ORDER BY category, position, name, id", args...)
	if err != nil {
		return nil, err
	}
	var out []*v1.Channel
	for rows.Next() {
		c := &v1.Channel{}
		var roles sql.NullString
		var header string
		if err := rows.Scan(&c.Id, &c.Kind, &c.Name, &c.Topic, &c.Category, &c.Position, &c.CreatedAtMs, &c.LastMessageSeq, &c.IsDefault, &roles, &header); err != nil {
			rows.Close()
			return nil, err
		}
		c.RoleIds = splitIDs(roles)
		if header != "" {
			c.HeaderImage = &v1.Attachment{Id: header}
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range out {
		if c.HeaderImage != nil {
			if c.HeaderImage, err = loadAttachment(ctx, q, c.HeaderImage.Id); err != nil {
				return nil, err
			}
		}
		if c.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
			if c.MemberIds, err = channelMemberIDs(ctx, q, c.Id); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// channelFor loads a channel the member may see (see roles.go). A channel
// they may not see is NOT_FOUND, so its existence does not leak.
func channelFor(ctx context.Context, q queryer, id, member string) (*v1.Channel, error) {
	cs, err := queryChannels(ctx, q, "id = ?", id)
	if err != nil || len(cs) == 0 {
		return nil, cmp.Or(err, errf(connect.CodeNotFound, "channel not found"))
	}
	ok := slices.Contains(cs[0].MemberIds, member)
	if cs[0].Kind == v1.ChannelKind_CHANNEL_KIND_TEXT {
		if ok, err = canSeeText(ctx, q, id, member); err != nil {
			return nil, err
		}
	}
	if !ok {
		return nil, errf(connect.CodeNotFound, "channel not found")
	}
	return cs[0], nil
}

const messageCols = "id, channel_id, author_id, text, created_at_ms, edited_at_ms, deleted, thread_root_id, reply_count, last_reply_at_ms, client_id, seq, created_seq"

// queryMessages loads messages, then their reactions and attachments with
// one query each for the whole page.
func queryMessages(ctx context.Context, q queryer, where string, args ...any) ([]*v1.Message, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+messageCols+" FROM messages WHERE "+where, args...)
	if err != nil {
		return nil, err
	}
	var out []*v1.Message
	byID := map[string]*v1.Message{}
	var ids []any
	for rows.Next() {
		m := &v1.Message{}
		if err := rows.Scan(&m.Id, &m.ChannelId, &m.AuthorId, &m.Text, &m.CreatedAtMs, &m.EditedAtMs, &m.Deleted,
			&m.ThreadRootId, &m.ReplyCount, &m.LastReplyAtMs, &m.ClientId, &m.Seq, &m.CreatedSeq); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
		if !m.Deleted {
			byID[m.Id] = m
			ids = append(ids, m.Id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return out, err
	}
	in := "(?" + strings.Repeat(",?", len(ids)-1) + ")"
	if err := loadReactions(ctx, q, in, ids, byID); err != nil {
		return nil, err
	}
	return out, loadAttachments(ctx, q, in, ids, byID)
}

func loadReactions(ctx context.Context, q queryer, in string, ids []any, byID map[string]*v1.Message) error {
	rows, err := q.QueryContext(ctx, "SELECT message_id, emoji, member_id FROM reactions WHERE message_id IN "+in+" ORDER BY at_ms, rowid", ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	byKey := map[[2]string]*v1.Reaction{}
	for rows.Next() {
		var msg, emoji, member string
		if err := rows.Scan(&msg, &emoji, &member); err != nil {
			return err
		}
		r := byKey[[2]string{msg, emoji}]
		if r == nil {
			r = &v1.Reaction{Emoji: emoji}
			byKey[[2]string{msg, emoji}] = r
			byID[msg].Reactions = append(byID[msg].Reactions, r)
		}
		r.MemberIds = append(r.MemberIds, member)
	}
	return rows.Err()
}

func loadAttachments(ctx context.Context, q queryer, in string, ids []any, byID map[string]*v1.Message) error {
	rows, err := q.QueryContext(ctx, "SELECT message_id, id, name, content_type, size, width, height FROM attachments WHERE message_id IN "+in+" ORDER BY created_at_ms, id", ids...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var msg string
		a := &v1.Attachment{}
		if err := rows.Scan(&msg, &a.Id, &a.Name, &a.ContentType, &a.Size, &a.Width, &a.Height); err != nil {
			return err
		}
		a.Url = fileURL(a.Id, a.Name)
		byID[msg].Attachments = append(byID[msg].Attachments, a)
	}
	return rows.Err()
}

// loadAttachment loads one upload by id, or nil if it is gone.
func loadAttachment(ctx context.Context, q queryer, id string) (*v1.Attachment, error) {
	a := &v1.Attachment{Id: id}
	err := q.QueryRowContext(ctx, "SELECT name, content_type, size, width, height FROM attachments WHERE id = ?", id).
		Scan(&a.Name, &a.ContentType, &a.Size, &a.Width, &a.Height)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	a.Url = fileURL(a.Id, a.Name)
	return a, err
}

// maxBanner caps banner and header images: everyone loads them.
const maxBanner = 8 << 20

// checkBannerUpload checks that id is the caller's own unattached image
// upload, small enough to show to everyone. "" (remove) passes.
func checkBannerUpload(ctx context.Context, q queryer, id, member string) error {
	if id == "" {
		return nil
	}
	var ctype string
	var size int64
	err := q.QueryRowContext(ctx, "SELECT content_type, size FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL", id, member).Scan(&ctype, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return errf(connect.CodeInvalidArgument, "upload the image first")
	}
	if err != nil {
		return err
	}
	switch ctype {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif":
	default:
		return errf(connect.CodeInvalidArgument, "the image must be PNG, JPEG, GIF, WebP or AVIF")
	}
	if size > maxBanner {
		return errf(connect.CodeInvalidArgument, "the image is larger than 8 MB")
	}
	return nil
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
	inviteOnly, err := isInviteOnly(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	desc, banner, err := s.profile(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	icon, err := s.iconURL(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	days, err := retentionDays(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GetServerInfoResponse{
		Name:            s.cfg.Name,
		Description:     desc,
		Banner:          banner,
		IconUrl:         icon,
		ProtocolVersion: protocolVersion,
		TrustedIssuers:  s.cfg.TrustedIssuers,
		BaseUrl:         s.cfg.BaseURL,
		MemberCount:     n,
		AccentColor:     s.cfg.Accent,
		InviteOnly:      inviteOnly,
		JoinQuestions:   s.joinQuestions(),
		RetentionDays:   days,
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
	if err := s.pluginJoin(id, display, r.Answers); err != nil {
		return nil, err
	}
	var out *memberRow
	created := false
	err := s.writeTx(ctx, func(t *wtx) error {
		var banned bool
		if err := t.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM bans WHERE iss = ? AND sub = ?)", id.iss, id.sub).Scan(&banned); err != nil {
			return err
		}
		if banned {
			return errf(connect.CodePermissionDenied, "you are banned from this community")
		}
		if err := useInvite(t, r.InviteCode, s.nowMs()); err != nil {
			return err
		}
		// A member who left or was kicked comes back with the same id.
		var oldID string
		err := t.QueryRowContext(ctx, "SELECT id FROM members WHERE iss = ? AND sub = ? AND deleted = 1", id.iss, id.sub).Scan(&oldID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if oldID != "" {
			seq, err := t.nextSeq()
			if err != nil {
				return err
			}
			if _, err := t.ExecContext(ctx, `UPDATE members SET deleted = 0, role = ?, display_name = ?, avatar_url = ?, bio = ?,
				status_text = '', status_emoji = '', joined_at_ms = ?, joined_seq = ? WHERE id = ?`,
				v1.MemberRole_MEMBER_ROLE_MEMBER, display, r.AvatarUrl, r.Bio, s.nowMs(), seq, oldID); err != nil {
				return err
			}
			if out, err = s.loadMember(ctx, t, "id = ?", oldID); err != nil {
				return err
			}
			created = true
			if err := t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberJoined{MemberJoined: out.Member}}, "", ""); err != nil {
				return err
			}
			return s.syncAccess(t, oldID)
		}
		existing, err := s.loadMember(ctx, t, "iss = ? AND sub = ?", id.iss, id.sub)
		if err != nil || existing != nil {
			out = existing
			return err
		}
		username, err := freeUsername(t, usernameBase(id.username))
		if err != nil {
			return err
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
		if _, err := t.ExecContext(ctx, `INSERT INTO members(id, kind, role, username, display_name, avatar_url, bio, joined_at_ms, joined_seq, iss, sub, username_claim)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, mid, v1.MemberKind_MEMBER_KIND_HUMAN, role, username, display, r.AvatarUrl, r.Bio,
			now.UnixMilli(), seq, id.iss, id.sub, id.username); err != nil {
			return err
		}
		if out, err = s.loadMember(ctx, t, "id = ?", mid); err != nil {
			return err
		}
		created = true
		s.log.Info("member joined", "member", mid, "role", role.String())
		if err := t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberJoined{MemberJoined: out.Member}}, "", ""); err != nil {
			return err
		}
		return s.syncAccess(t, mid)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.JoinResponse{Member: out.Member, Created: created}), nil
}

// freeUsername returns base, or base2, base3, ... when it is taken.
func freeUsername(t *wtx, base string) (string, error) {
	name := base
	for n := 2; ; n++ {
		var taken bool
		if err := t.QueryRowContext(t.ctx, "SELECT EXISTS(SELECT 1 FROM members WHERE username = ?)", name).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return name, nil
		}
		name = fmt.Sprintf("%s%d", base, n)
	}
}

// syncUsername follows a rename on the account server (1095). It runs only
// when the token's preferred_username differs from the one last seen.
//
// Collision: the account server keeps usernames unique per issuer, so
// another human from the same issuer holding the name, with the same or an
// unknown last-seen claim, has renamed since we saw them. They move to
// base2, base3, ... and get their own new name on their next request. Any
// other holder (a bot, another issuer, or a different claim that normalizes
// to the same name) keeps it, and the caller gets the join rule's suffix.
func (s *Server) syncUsername(ctx context.Context, id *identity) (*memberRow, error) {
	var out *memberRow
	err := s.writeTx(ctx, func(t *wtx) error {
		m, err := s.loadMember(ctx, t, "id = ?", id.member.Id)
		if err != nil || m == nil || m.claim == id.username {
			out = m
			return err
		}
		base := usernameBase(id.username)
		name := m.Username
		if name != base {
			var other, iss, claim string
			var deleted bool
			err := t.QueryRowContext(ctx, "SELECT id, COALESCE(iss, ''), username_claim, deleted FROM members WHERE username = ?", base).
				Scan(&other, &iss, &claim, &deleted)
			switch {
			case errors.Is(err, sql.ErrNoRows):
				name = base
			case err != nil:
				return err
			case iss == id.iss && (claim == id.username || claim == ""):
				moved, err := freeUsername(t, base)
				if err != nil {
					return err
				}
				if err := s.setUsername(t, other, moved, !deleted); err != nil {
					return err
				}
				name = base
			default:
				if name, err = freeUsername(t, base); err != nil {
					return err
				}
			}
		}
		if _, err := t.ExecContext(ctx, "UPDATE members SET username_claim = ? WHERE id = ?", id.username, m.Id); err != nil {
			return err
		}
		if name == m.Username {
			out = m
			return nil
		}
		if err := s.setUsername(t, m.Id, name, true); err != nil {
			return err
		}
		out, err = s.loadMember(ctx, t, "id = ?", m.Id)
		return err
	})
	return out, err
}

// setUsername renames a member and, if announce, tells clients.
func (s *Server) setUsername(t *wtx, id, name string, announce bool) error {
	if _, err := t.ExecContext(t.ctx, "UPDATE members SET username = ? WHERE id = ?", name, id); err != nil {
		return err
	}
	if !announce {
		return nil
	}
	m, err := s.loadMember(t.ctx, t, "id = ?", id)
	if err != nil {
		return err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberUpdated{MemberUpdated: m.Member}}, "", "")
}

func (s *Server) GetMe(ctx context.Context, _ *connect.Request[v1.GetMeRequest]) (*connect.Response[v1.GetMeResponse], error) {
	m := me(ctx)
	resp := &v1.GetMeResponse{Member: m.Member}
	if isAdmin(m) {
		resp.ServerVersion, resp.ServerTrack = s.cfg.Version, s.cfg.Track
		if v := s.updateAvailable.Load(); v != nil {
			resp.UpdateAvailable = *v
		}
	}
	return connect.NewResponse(resp), nil
}

func (s *Server) UpdateProfile(ctx context.Context, req *connect.Request[v1.UpdateProfileRequest]) (*connect.Response[v1.UpdateProfileResponse], error) {
	r := req.Msg
	avatar, upload := r.AvatarUrl, ""
	if avatar != nil {
		if id, ok := s.localAvatar(*avatar); ok {
			avatar, upload = nil, id
		}
	}
	if err := checkProfile(r.DisplayName, avatar, r.Bio); err != nil {
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
		if avatar == nil && r.AvatarUrl != nil {
			p, err := avatarPath(ctx, t, upload, m.Id)
			if err != nil {
				return err
			}
			r.AvatarUrl = &p
		}
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
	if out.Channels, err = queryChannels(ctx, tx, "id IN (SELECT channel_id FROM channel_members WHERE member_id = ?)", m.Id); err != nil {
		return nil, err
	}
	if out.Roles, err = listRoles(ctx, tx); err != nil {
		return nil, err
	}
	if out.ChannelMode, err = channelMode(ctx, tx); err != nil {
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
	// A kick commits before it drops subscriptions; one registered after
	// that drop must see the kick here.
	if _, err := s.liveMember(ctx, s.db.r, m.Id); err != nil {
		return errf(connect.CodePermissionDenied, "you are no longer a member")
	}

	// Nothing from before they joined: ListMessages shows that, the log
	// also holds deleted and pre-edit text.
	last := max(req.Msg.AfterSeq, m.joinedSeq)
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

	// flush sends first, everything else already queued, then the latest
	// presence, with one network flush. Queued events go before presence so
	// a member_joined is never overtaken by that member's presence.
	hw, _ := ctx.Value(heldWriterKey{}).(*heldWriter)
	if hw == nil {
		hw = &heldWriter{}
	}
	send := func(ev *v1.Event) error {
		if ev.Seq != 0 {
			if ev.Seq <= last {
				return nil
			}
			last = ev.Seq
		}
		return stream.Send(ev)
	}
	flush := func(first *v1.Event) error {
		hw.hold = true
		defer func() { hw.hold = false }()
		if first != nil {
			if err := send(first); err != nil {
				return err
			}
		}
		for range len(sb.ch) {
			if err := send(<-sb.ch); err != nil {
				return err
			}
		}
		if ev := presenceBatch(s.hub.takePresence(sb), s.nowMs()); ev != nil {
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
		hw.hold = false
		if hw.ResponseWriter != nil {
			hw.Flush()
		}
		return nil
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
			if err := flush(ev); err != nil {
				return err
			}
		case <-sb.wake:
			if err := flush(nil); err != nil {
				return err
			}
		case <-tick.C:
			if err := stream.Send(&v1.Event{AtMs: s.nowMs(), Kind: &v1.Event_Heartbeat{Heartbeat: true}}); err != nil {
				return err
			}
		}
	}
}

// presenceBatch turns pending presence into one event: a plain presence
// event for one change, a PresenceBatch for more (1061), nil for none.
func presenceBatch(pending map[string]*v1.Event, at int64) *v1.Event {
	if len(pending) <= 1 {
		for _, ev := range pending {
			return ev
		}
		return nil
	}
	b := &v1.PresenceBatch{}
	for _, ev := range pending {
		b.Changes = append(b.Changes, ev.GetPresence())
	}
	return &v1.Event{AtMs: at, Kind: &v1.Event_PresenceBatch{PresenceBatch: b}}
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
	if err := checkText("topic", r.Topic, maxTopicChars, false); err != nil {
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

// createChannel inserts a channel with members in it.
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
	for _, mid := range members {
		if _, err := t.ExecContext(ctx, "INSERT OR IGNORE INTO channel_members(channel_id, member_id) VALUES (?,?)", id, mid); err != nil {
			return nil, err
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
	if err := t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelCreated{ChannelCreated: cs[0]}}, id, ""); err != nil {
		return nil, err
	}
	// In ROLES mode everyone who can see a new text channel is in it.
	if kind == v1.ChannelKind_CHANNEL_KIND_TEXT {
		return cs[0], s.syncAccess(t, "")
	}
	return cs[0], nil
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
		if err := checkText("topic", *r.Topic, maxTopicChars, false); err != nil {
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
		if r.HeaderImageId != nil {
			if err := checkBannerUpload(ctx, t, *r.HeaderImageId, m.Id); err != nil {
				return err
			}
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
		if r.HeaderImageId != nil && err == nil {
			_, err = t.ExecContext(ctx, "UPDATE channels SET header_image_id = ? WHERE id = ?", *r.HeaderImageId, old.Id)
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
		return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelUpdated{ChannelUpdated: c}}, c.Id, "")
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
	anchor, field := "", ""
	for _, f := range [][2]string{{"before_id", r.BeforeId}, {"after_id", r.AfterId}, {"around_id", r.AroundId}} {
		if f[1] != "" {
			if anchor != "" {
				return nil, errf(connect.CodeInvalidArgument, "set only one of before_id, after_id and around_id")
			}
			anchor, field = f[1], f[0]
		}
	}
	at := int64(math.MaxInt64)
	if anchor != "" {
		err := s.db.r.QueryRowContext(ctx, "SELECT created_seq FROM messages WHERE id = ? AND channel_id = ? AND thread_root_id = ?",
			anchor, r.ChannelId, r.ThreadRootId).Scan(&at)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errf(connect.CodeInvalidArgument, "%s is not a message in this channel or thread", field)
		} else if err != nil {
			return nil, err
		}
	}
	// Expired messages the prune has not reached yet are already gone.
	cutoff, err := s.retentionCutoff(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	// page returns up to n messages on one side of seq, nearest first, and
	// whether there are more.
	page := func(op string, seq int64, n int) ([]*v1.Message, bool, error) {
		order := "ASC"
		if op == "<" {
			order = "DESC"
		}
		ms, err := queryMessages(ctx, s.db.r, `channel_id = ? AND thread_root_id = ? AND created_seq `+op+` ? AND (deleted = 0 OR reply_count > 0) AND created_at_ms >= ?
			ORDER BY created_seq `+order+` LIMIT ?`, r.ChannelId, r.ThreadRootId, seq, cutoff, n+1)
		if len(ms) > n {
			return ms[:n], true, err
		}
		return ms, false, err
	}
	out := &v1.ListMessagesResponse{}
	var older, newer []*v1.Message
	switch field {
	case "after_id":
		newer, out.HasMoreAfter, err = page(">", at, limit)
	case "around_id":
		if older, out.HasMore, err = page("<", at, limit/2); err == nil {
			newer, out.HasMoreAfter, err = page(">=", at, limit-len(older))
		}
	default:
		older, out.HasMore, err = page("<", at, limit)
	}
	if err != nil {
		return nil, err
	}
	slices.Reverse(older)
	out.Messages = append(older, newer...)
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
	s.pluginMessage(m, out)
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
	scope := c.Id
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
		if err := s.emitMessageUpdated(t, msg.Id, c.Id, now); err != nil {
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
		if err := purgeMessageEvents(t, msg.ChannelId, msg.Id, msg.CreatedSeq); err != nil {
			return err
		}
		now := s.nowMs()
		scope := c.Id
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

// purgeMessageEvents drops a message's earlier events, which still carry
// its text, so a Subscribe replay cannot bring a deleted message back.
// ponytail: decodes the channel's kept events since the message; add an
// events.message_id column if deletes in busy channels get slow.
func purgeMessageEvents(t *wtx, channel, id string, from int64) error {
	rows, err := t.QueryContext(t.ctx, "SELECT seq, payload FROM events WHERE scope_channel = ? AND seq >= ?", channel, from)
	if err != nil {
		return err
	}
	var gone []int64
	for rows.Next() {
		var seq int64
		var payload []byte
		if err := rows.Scan(&seq, &payload); err != nil {
			rows.Close()
			return err
		}
		ev := &v1.Event{}
		if proto.Unmarshal(payload, ev) == nil && cmp.Or(ev.GetMessageCreated(), ev.GetMessageUpdated()).GetId() == id {
			gone = append(gone, seq)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, seq := range gone {
		if _, err := t.ExecContext(t.ctx, "DELETE FROM events WHERE seq = ?", seq); err != nil {
			return err
		}
	}
	return nil
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
		if err := s.emitMessageUpdated(t, msg.Id, c.Id, s.nowMs()); err != nil {
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
	// Read first, outside the writer: a mark at or behind the stored one
	// (a repeat, or a late reply racing a newer one) changes nothing.
	c, err := channelFor(ctx, s.db.r, r.ChannelId, m.Id)
	if err != nil {
		return nil, err
	}
	cur, err := currentSeq(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	seq := r.Seq
	if seq <= 0 || seq > cur {
		seq = cur
	}
	var stored int64
	if err := s.db.r.QueryRowContext(ctx, "SELECT COALESCE((SELECT last_read_seq FROM read_states WHERE member_id = ? AND channel_id = ?), 0)",
		m.Id, c.Id).Scan(&stored); err != nil {
		return nil, err
	}
	if stored >= seq {
		rs, err := readState(ctx, s.db.r, m, c)
		if err != nil {
			return nil, err
		}
		return connect.NewResponse(&v1.MarkReadResponse{ReadState: rs}), nil
	}
	var rs *v1.ReadState
	err = s.writeTx(ctx, func(t *wtx) error {
		if _, err := t.ExecContext(ctx, `INSERT INTO read_states(member_id, channel_id, last_read_seq) VALUES (?,?,?)
			ON CONFLICT(member_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`, m.Id, c.Id, seq); err != nil {
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
	ids, err := channelMemberIDs(ctx, s.db.r, c.Id)
	if err != nil {
		return nil, err
	}
	aud := map[string]bool{}
	for _, id := range ids {
		aud[id] = true
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
	// Everywhere means the channels I am in; one channel may be any I can see.
	where := `n IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) AND deleted = 0
		AND channel_id IN (SELECT channel_id FROM channel_members WHERE member_id = ?)`
	args := []any{ftsQuery(q), m.Id}
	if r.ChannelId != "" {
		if _, err := channelFor(ctx, s.db.r, r.ChannelId, m.Id); err != nil {
			return nil, err
		}
		where = `n IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) AND deleted = 0 AND channel_id = ?`
		args = []any{ftsQuery(q), r.ChannelId}
	}
	// Expired messages the prune has not reached yet are already gone.
	cutoff, err := s.retentionCutoff(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	ms, err := queryMessages(ctx, s.db.r, where+" AND created_at_ms >= ? ORDER BY created_seq DESC LIMIT ?", append(args, cutoff, limit)...)
	if err != nil {
		if strings.Contains(err.Error(), "fts5") {
			return nil, errf(connect.CodeInvalidArgument, "cannot search for that")
		}
		return nil, err
	}
	return connect.NewResponse(&v1.SearchResponse{Messages: ms}), nil
}

// ---------------------------------------------------------------------------
// Membership and moderation
// ---------------------------------------------------------------------------

const maxAddMembers = 50

// privateChannelFor loads a private channel the caller is in.
func privateChannelFor(ctx context.Context, q queryer, id, member string) (*v1.Channel, error) {
	c, err := channelFor(ctx, q, id, member)
	if err == nil && c.Kind != v1.ChannelKind_CHANNEL_KIND_PRIVATE {
		err = errf(connect.CodeInvalidArgument, "only private channels have a member list")
	}
	return c, err
}

// liveMember loads a member who has not left, or NOT_FOUND.
func (s *Server) liveMember(ctx context.Context, q queryer, id string) (*memberRow, error) {
	m, err := s.loadMember(ctx, q, "id = ? AND deleted = 0", id)
	if err == nil && m == nil {
		err = errf(connect.CodeNotFound, "member %s not found", id)
	}
	return m, err
}

// emitChannelUpdated reloads c and tells its members.
func emitChannelUpdated(t *wtx, id string) (*v1.Channel, error) {
	cs, err := queryChannels(t.ctx, t, "id = ?", id)
	if err != nil {
		return nil, err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return nil, err
	}
	return cs[0], t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelUpdated{ChannelUpdated: cs[0]}}, id, "")
}

func (s *Server) AddChannelMembers(ctx context.Context, req *connect.Request[v1.AddChannelMembersRequest]) (*connect.Response[v1.AddChannelMembersResponse], error) {
	m := me(ctx)
	r := req.Msg
	if len(r.MemberIds) == 0 || len(r.MemberIds) > maxAddMembers {
		return nil, errf(connect.CodeInvalidArgument, "add 1 to %d members at a time", maxAddMembers)
	}
	for _, id := range r.MemberIds {
		if err := checkID("member_ids", id); err != nil {
			return nil, err
		}
	}
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		if c, err = privateChannelFor(ctx, t, r.ChannelId, m.Id); err != nil {
			return err
		}
		cur, err := currentSeq(ctx, t)
		if err != nil {
			return err
		}
		added := 0
		for _, id := range r.MemberIds {
			if _, err := s.liveMember(ctx, t, id); err != nil {
				return err
			}
			res, err := t.ExecContext(ctx, "INSERT OR IGNORE INTO channel_members(channel_id, member_id) VALUES (?,?)", c.Id, id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				added++
				// Old history is not unread for a new channel member.
				if _, err := t.ExecContext(ctx, `INSERT INTO read_states(member_id, channel_id, last_read_seq) VALUES (?,?,?)
					ON CONFLICT(member_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`, id, c.Id, cur); err != nil {
					return err
				}
			}
		}
		if added == 0 {
			return nil
		}
		c, err = emitChannelUpdated(t, c.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.AddChannelMembersResponse{Channel: c}), nil
}

func (s *Server) RemoveChannelMember(ctx context.Context, req *connect.Request[v1.RemoveChannelMemberRequest]) (*connect.Response[v1.RemoveChannelMemberResponse], error) {
	m := me(ctx)
	r := req.Msg
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		if c, err = privateChannelFor(ctx, t, r.ChannelId, m.Id); err != nil {
			return err
		}
		if !slices.Contains(c.MemberIds, r.MemberId) {
			return errf(connect.CodeNotFound, "member %s is not in this channel", r.MemberId)
		}
		if r.MemberId != m.Id {
			actor, err := s.liveMember(ctx, t, m.Id)
			if err != nil {
				return err
			}
			target, err := s.loadMember(ctx, t, "id = ?", r.MemberId)
			if err != nil {
				return err
			}
			if !outranks(actor.Role, target.Role) {
				return errf(connect.CodePermissionDenied, "you can only remove members of a lower role")
			}
		}
		if err := removeFromChannel(t, c.Id, r.MemberId); err != nil {
			return err
		}
		c, err = emitChannelUpdated(t, c.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RemoveChannelMemberResponse{Channel: c}), nil
}

// removeFromChannel deletes the membership and tells the removed member the
// channel is gone for them.
func removeFromChannel(t *wtx, channel, member string) error {
	if _, err := t.ExecContext(t.ctx, "DELETE FROM channel_members WHERE channel_id = ? AND member_id = ?", channel, member); err != nil {
		return err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelDeleted{ChannelDeleted: channel}}, "", member)
}

func (s *Server) SetMemberRole(ctx context.Context, req *connect.Request[v1.SetMemberRoleRequest]) (*connect.Response[v1.SetMemberRoleResponse], error) {
	r := req.Msg
	switch r.Role {
	case v1.MemberRole_MEMBER_ROLE_MEMBER, v1.MemberRole_MEMBER_ROLE_MODERATOR, v1.MemberRole_MEMBER_ROLE_ADMIN:
	default:
		return nil, errf(connect.CodeInvalidArgument, "role must be MEMBER, MODERATOR or ADMIN")
	}
	var out *memberRow
	err := s.writeTx(ctx, func(t *wtx) error {
		actor, err := s.liveMember(ctx, t, me(ctx).Id)
		if err != nil {
			return err
		}
		target, err := s.liveMember(ctx, t, r.MemberId)
		if err != nil {
			return err
		}
		if !isAdmin(actor) || !outranks(actor.Role, target.Role) || !outranks(actor.Role, r.Role) {
			return errf(connect.CodePermissionDenied, "only admins set roles, and only below their own")
		}
		if _, err := t.ExecContext(ctx, "UPDATE members SET role = ? WHERE id = ?", r.Role, target.Id); err != nil {
			return err
		}
		if out, err = s.loadMember(ctx, t, "id = ?", target.Id); err != nil {
			return err
		}
		seq, err := t.nextSeq()
		if err != nil {
			return err
		}
		if err := t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberUpdated{MemberUpdated: out.Member}}, "", ""); err != nil {
			return err
		}
		return s.syncAccess(t, "")
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("role set", "member", out.Id, "role", out.Role.String(), "by", me(ctx).Id)
	return connect.NewResponse(&v1.SetMemberRoleResponse{Member: out.Member}), nil
}

func (s *Server) LeaveCommunity(ctx context.Context, _ *connect.Request[v1.LeaveCommunityRequest]) (*connect.Response[v1.LeaveCommunityResponse], error) {
	m := me(ctx)
	err := s.writeTx(ctx, func(t *wtx) error {
		self, err := s.liveMember(ctx, t, m.Id)
		if err != nil {
			return err
		}
		if self.Role == v1.MemberRole_MEMBER_ROLE_OWNER {
			return errf(connect.CodeFailedPrecondition, "the owner cannot leave")
		}
		return s.removeMember(t, self.Id)
	})
	if err != nil {
		return nil, err
	}
	s.hub.drop(m.Id)
	return connect.NewResponse(&v1.LeaveCommunityResponse{}), nil
}

func (s *Server) KickMember(ctx context.Context, req *connect.Request[v1.KickMemberRequest]) (*connect.Response[v1.KickMemberResponse], error) {
	if err := s.kick(ctx, req.Msg.MemberId, false); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.KickMemberResponse{}), nil
}

func (s *Server) BanMember(ctx context.Context, req *connect.Request[v1.BanMemberRequest]) (*connect.Response[v1.BanMemberResponse], error) {
	if err := s.kick(ctx, req.Msg.MemberId, true); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.BanMemberResponse{}), nil
}

func requireModerator(ctx context.Context) error {
	if !canModerate(me(ctx)) {
		return errf(connect.CodePermissionDenied, "only moderators and up can manage bans")
	}
	return nil
}

func (s *Server) ListBans(ctx context.Context, _ *connect.Request[v1.ListBansRequest]) (*connect.Response[v1.ListBansResponse], error) {
	if err := requireModerator(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.r.QueryContext(ctx, "SELECT member_id, by_id, at_ms FROM bans ORDER BY at_ms DESC, rowid DESC")
	if err != nil {
		return nil, err
	}
	out := &v1.ListBansResponse{}
	var ids []string
	for rows.Next() {
		b := &v1.Ban{}
		var id string
		if err := rows.Scan(&id, &b.BannedBy, &b.BannedAtMs); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		out.Bans = append(out.Bans, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, id := range ids {
		m, err := s.loadMember(ctx, s.db.r, "id = ?", id)
		if err != nil {
			return nil, err
		}
		if m != nil {
			out.Bans[i].Member = m.Member
		}
	}
	return connect.NewResponse(out), nil
}

func (s *Server) UnbanMember(ctx context.Context, req *connect.Request[v1.UnbanMemberRequest]) (*connect.Response[v1.UnbanMemberResponse], error) {
	if err := requireModerator(ctx); err != nil {
		return nil, err
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		res, err := t.ExecContext(ctx, "DELETE FROM bans WHERE member_id = ?", req.Msg.MemberId)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errf(connect.CodeNotFound, "that member is not banned")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("member unbanned", "member", req.Msg.MemberId, "by", me(ctx).Id)
	return connect.NewResponse(&v1.UnbanMemberResponse{}), nil
}

// kick removes a person of lower rank, and with ban also blocks their login.
func (s *Server) kick(ctx context.Context, memberID string, ban bool) error {
	by := me(ctx).Id
	err := s.writeTx(ctx, func(t *wtx) error {
		actor, err := s.liveMember(ctx, t, by)
		if err != nil {
			return err
		}
		target, err := s.liveMember(ctx, t, memberID)
		if err != nil {
			return err
		}
		if target.Kind != v1.MemberKind_MEMBER_KIND_HUMAN {
			return errf(connect.CodeInvalidArgument, "use DeleteBot to remove a bot")
		}
		if !outranks(actor.Role, target.Role) {
			return errf(connect.CodePermissionDenied, "you can only remove members of a lower role")
		}
		if ban {
			if _, err := t.ExecContext(ctx, `INSERT OR IGNORE INTO bans(iss, sub, member_id, by_id, at_ms)
				SELECT iss, sub, id, ?, ? FROM members WHERE id = ?`, by, s.nowMs(), target.Id); err != nil {
				return err
			}
		}
		return s.removeMember(t, target.Id)
	})
	if err != nil {
		return err
	}
	s.log.Info("member removed", "member", memberID, "by", by, "ban", ban)
	s.hub.drop(memberID)
	return nil
}

// removeMember takes a member out of the community, its channels and its
// roles. The row stays, so old messages keep their author and Join can
// bring them back. DMs are kept.
func (s *Server) removeMember(t *wtx, id string) error {
	ctx := t.ctx
	rows, err := t.QueryContext(ctx, `SELECT channel_id FROM channel_members WHERE member_id = ?
		AND channel_id IN (SELECT id FROM channels WHERE kind = ?)`, id, v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	if err != nil {
		return err
	}
	var channels []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			rows.Close()
			return err
		}
		channels = append(channels, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, c := range channels {
		if err := removeFromChannel(t, c, id); err != nil {
			return err
		}
		if _, err := emitChannelUpdated(t, c); err != nil {
			return err
		}
	}
	if _, err := t.ExecContext(ctx, "UPDATE members SET deleted = 1, role = ? WHERE id = ?", v1.MemberRole_MEMBER_ROLE_MEMBER, id); err != nil {
		return err
	}
	// Their subscriptions are dropped, so text channels and roles go quietly.
	if _, err := t.ExecContext(ctx, "DELETE FROM channel_members WHERE member_id = ? AND channel_id IN (SELECT id FROM channels WHERE kind = ?)",
		id, v1.ChannelKind_CHANNEL_KIND_TEXT); err != nil {
		return err
	}
	if _, err := t.ExecContext(ctx, "DELETE FROM member_roles WHERE member_id = ?", id); err != nil {
		return err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_MemberLeft{MemberLeft: id}}, "", "")
}

// ---------------------------------------------------------------------------
// Invites and settings
// ---------------------------------------------------------------------------

const (
	maxInviteLife = 365 * 24 * time.Hour
	maxInviteUses = 1_000_000
)

// profile returns the community's description (set at runtime, else the
// -description flag) and banner.
func (s *Server) profile(ctx context.Context, q queryer) (string, *v1.Attachment, error) {
	var desc, banner string
	err := q.QueryRowContext(ctx, `SELECT COALESCE((SELECT value FROM settings WHERE key = 'description'), ''),
		COALESCE((SELECT value FROM settings WHERE key = 'banner'), '')`).Scan(&desc, &banner)
	if err != nil || banner == "" {
		return cmp.Or(desc, s.cfg.Description), nil, err
	}
	a, err := loadAttachment(ctx, q, banner)
	return cmp.Or(desc, s.cfg.Description), a, err
}

// iconURL returns the uploaded rail icon's signed URL, else -icon-url.
func (s *Server) iconURL(ctx context.Context, q queryer) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT value FROM settings WHERE key = 'icon'), '')").Scan(&id)
	if err != nil || id == "" {
		return s.cfg.IconURL, err
	}
	a, err := loadAttachment(ctx, q, id)
	if err != nil || a == nil {
		return s.cfg.IconURL, err
	}
	return signedFileURL(s.fileKey, a.Id, a.Name, s.now()), nil
}

func isInviteOnly(ctx context.Context, q queryer) (bool, error) {
	var on bool
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT value = '1' FROM settings WHERE key = 'invite_only'), 0)").Scan(&on)
	return on, err
}

// useInvite lets a Join through: always on an open community, and for the
// first person (the owner). Otherwise it needs a usable code and counts a use.
func useInvite(t *wtx, code string, nowMs int64) error {
	on, err := isInviteOnly(t.ctx, t)
	if err != nil || !on {
		return err
	}
	var humans int
	if err := t.QueryRowContext(t.ctx, "SELECT COUNT(*) FROM members WHERE iss IS NOT NULL").Scan(&humans); err != nil || humans == 0 {
		return err
	}
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return errf(connect.CodePermissionDenied, "this community is invite-only; you need an invite code")
	}
	res, err := t.ExecContext(t.ctx, `UPDATE invites SET uses = uses + 1 WHERE code = ?
		AND (expires_at_ms = 0 OR expires_at_ms > ?) AND (max_uses = 0 OR uses < max_uses)`, code, nowMs)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errf(connect.CodePermissionDenied, "that invite code is invalid, expired or used up")
	}
	return nil
}

func requireAdmin(ctx context.Context) error {
	if !isAdmin(me(ctx)) {
		return errf(connect.CodePermissionDenied, "only admins can manage invites and settings")
	}
	return nil
}

const inviteCols = "code, created_by, created_at_ms, expires_at_ms, max_uses, uses"

func scanInvite(sc scanner) (*v1.Invite, error) {
	i := &v1.Invite{}
	return i, sc.Scan(&i.Code, &i.CreatedBy, &i.CreatedAtMs, &i.ExpiresAtMs, &i.MaxUses, &i.Uses)
}

func (s *Server) CreateInvite(ctx context.Context, req *connect.Request[v1.CreateInviteRequest]) (*connect.Response[v1.CreateInviteResponse], error) {
	if err := requireAdmin(ctx); err != nil {
		return nil, err
	}
	r := req.Msg
	if r.ExpiresInSeconds < 0 || r.ExpiresInSeconds > int64(maxInviteLife/time.Second) {
		return nil, errf(connect.CodeInvalidArgument, "expires_in_seconds must be 0 (never) to one year")
	}
	if r.MaxUses < 0 || r.MaxUses > maxInviteUses {
		return nil, errf(connect.CodeInvalidArgument, "max_uses must be 0 (no limit) to %d", maxInviteUses)
	}
	now := s.now()
	var exp int64
	if r.ExpiresInSeconds > 0 {
		exp = now.Add(time.Duration(r.ExpiresInSeconds) * time.Second).UnixMilli()
	}
	code := rand.Text()[:10] // 50 random bits
	var inv *v1.Invite
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		inv, err = scanInvite(t.QueryRowContext(ctx, "INSERT INTO invites(code, created_by, created_at_ms, expires_at_ms, max_uses) VALUES (?,?,?,?,?) RETURNING "+inviteCols,
			code, me(ctx).Id, now.UnixMilli(), exp, r.MaxUses))
		return err
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("invite created", "by", me(ctx).Id, "max_uses", r.MaxUses, "expires_at_ms", exp)
	return connect.NewResponse(&v1.CreateInviteResponse{Invite: inv}), nil
}

func (s *Server) ListInvites(ctx context.Context, _ *connect.Request[v1.ListInvitesRequest]) (*connect.Response[v1.ListInvitesResponse], error) {
	if err := requireAdmin(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.r.QueryContext(ctx, "SELECT "+inviteCols+" FROM invites ORDER BY created_at_ms DESC, rowid DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &v1.ListInvitesResponse{}
	for rows.Next() {
		inv, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out.Invites = append(out.Invites, inv)
	}
	return connect.NewResponse(out), rows.Err()
}

func (s *Server) RevokeInvite(ctx context.Context, req *connect.Request[v1.RevokeInviteRequest]) (*connect.Response[v1.RevokeInviteResponse], error) {
	if err := requireAdmin(ctx); err != nil {
		return nil, err
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		res, err := t.ExecContext(ctx, "DELETE FROM invites WHERE code = ?", strings.ToUpper(strings.TrimSpace(req.Msg.Code)))
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errf(connect.CodeNotFound, "invite not found")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RevokeInviteResponse{}), nil
}

func (s *Server) UpdateServerSettings(ctx context.Context, req *connect.Request[v1.UpdateServerSettingsRequest]) (*connect.Response[v1.UpdateServerSettingsResponse], error) {
	if err := requireAdmin(ctx); err != nil {
		return nil, err
	}
	r := req.Msg
	if r.Description != nil {
		if err := checkText("description", *r.Description, maxDescriptionChars, false); err != nil {
			return nil, err
		}
	}
	if r.RetentionDays != nil && (*r.RetentionDays < 0 || *r.RetentionDays > maxRetentionDays) {
		return nil, errf(connect.CodeInvalidArgument, "retention_days must be 0 (keep forever) to %d", maxRetentionDays)
	}
	out := &v1.UpdateServerSettingsResponse{}
	err := s.writeTx(ctx, func(t *wtx) error {
		profile := map[string]*string{"description": r.Description, "banner": r.BannerId, "icon": r.IconId}
		for _, id := range []*string{r.BannerId, r.IconId} {
			if id == nil {
				continue
			}
			if err := checkBannerUpload(ctx, t, *id, me(ctx).Id); err != nil {
				return err
			}
		}
		changed := false
		for key, v := range profile {
			if v == nil {
				continue
			}
			if _, err := t.ExecContext(ctx, "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, strings.TrimSpace(*v)); err != nil {
				return err
			}
			changed = true
		}
		if r.RetentionDays != nil {
			if _, err := t.ExecContext(ctx, "INSERT INTO settings(key, value) VALUES ('retention_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", *r.RetentionDays); err != nil {
				return err
			}
			changed = true
		}
		if changed {
			seq, err := t.nextSeq()
			if err != nil {
				return err
			}
			if err := t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ServerUpdated{ServerUpdated: true}}, "", ""); err != nil {
				return err
			}
		}
		var err error
		if out.Description, out.Banner, err = s.profile(ctx, t); err != nil {
			return err
		}
		if out.IconUrl, err = s.iconURL(ctx, t); err != nil {
			return err
		}
		if v := req.Msg.InviteOnly; v != nil {
			val := "0"
			if *v {
				val = "1"
			}
			if _, err := t.ExecContext(ctx, "INSERT INTO settings(key, value) VALUES ('invite_only', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", val); err != nil {
				return err
			}
		}
		if err := s.setChannelMode(t, req.Msg.ChannelMode); err != nil {
			return err
		}
		if out.ChannelMode, err = channelMode(ctx, t); err != nil {
			return err
		}
		if out.RetentionDays, err = retentionDays(ctx, t); err != nil {
			return err
		}
		out.InviteOnly, err = isInviteOnly(ctx, t)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("settings updated", "by", me(ctx).Id, "invite_only", out.InviteOnly, "channel_mode", out.ChannelMode.String(), "retention_days", out.RetentionDays)
	return connect.NewResponse(out), nil
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
	if err == nil && (exists(filepath.Join(s.pluginDir(), bot.Username+".js")) || exists(filepath.Join(s.pluginDir(), bot.Username+".js.disabled"))) {
		err = errf(connect.CodeFailedPrecondition, "%s is a plugin's bot; delete or turn off the plugin instead", bot.Username)
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
	s.hub.drop(req.Msg.BotId) // streams opened with the old token
	return connect.NewResponse(&v1.RotateBotTokenResponse{Token: token}), nil
}

func (s *Server) DeleteBot(ctx context.Context, req *connect.Request[v1.DeleteBotRequest]) (*connect.Response[v1.DeleteBotResponse], error) {
	err := s.writeTx(ctx, func(t *wtx) error {
		bot, err := s.botFor(ctx, t, req.Msg.BotId)
		if err != nil {
			return err
		}
		return deleteBot(t, bot.Id)
	})
	if err != nil {
		return nil, err
	}
	s.hub.drop(req.Msg.BotId)
	return connect.NewResponse(&v1.DeleteBotResponse{}), nil
}

func deleteBot(t *wtx, id string) error {
	// Keep the row so old messages still have an author, and free the
	// username: "~" is not allowed in usernames, so this cannot collide.
	if _, err := t.ExecContext(t.ctx, "UPDATE members SET token_hash = NULL, username = username || '~' || id WHERE id = ?", id); err != nil {
		return err
	}
	return t.s.removeMember(t, id)
}
