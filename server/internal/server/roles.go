package server

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Who sees a text channel: admins and the owner always; everyone when the
// channel has no roles; otherwise members with one of its roles. Private
// channels and DMs use their member list only.
//
// Text channels keep a member list (channel_members) like private ones, and
// channel events go only to that list. In ROLES mode syncAccess keeps it equal
// to "everyone who can see it"; in OPT_IN mode members join and leave, and
// syncAccess only takes out those who can no longer see it.

// visibleSQL is true when member m may see text channel c (SQL aliases).
var visibleSQL = fmt.Sprintf(`(m.role >= %d OR NOT EXISTS (SELECT 1 FROM channel_roles cr WHERE cr.channel_id = c.id)
	OR EXISTS (SELECT 1 FROM channel_roles cr JOIN member_roles mr ON mr.role_id = cr.role_id WHERE cr.channel_id = c.id AND mr.member_id = m.id))`,
	v1.MemberRole_MEMBER_ROLE_ADMIN)

func canSeeText(ctx context.Context, q queryer, channelID, memberID string) (bool, error) {
	var ok bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM channels c JOIN members m ON m.id = ?
		WHERE c.id = ? AND c.kind = ? AND m.deleted = 0 AND `+visibleSQL+`)`,
		memberID, channelID, v1.ChannelKind_CHANNEL_KIND_TEXT).Scan(&ok)
	return ok, err
}

// requireJoined: in OPT_IN mode, posting, reacting and typing in a text
// channel need membership, as in Slack. Reading a preview does not. Call it
// after channelFor, so a channel the member cannot see stays NOT_FOUND.
func requireJoined(ctx context.Context, q queryer, c *v1.Channel, member string) error {
	if c.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
		return nil
	}
	var in bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?)
		OR COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'channel_mode'), ?) != ?`,
		c.Id, member, v1.ChannelMode_CHANNEL_MODE_ROLES, v1.ChannelMode_CHANNEL_MODE_OPT_IN).Scan(&in)
	if err == nil && !in {
		err = errf(connect.CodeFailedPrecondition, "join #%s first", c.Name)
	}
	return err
}

func channelMode(ctx context.Context, q queryer) (v1.ChannelMode, error) {
	var mode v1.ChannelMode
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'channel_mode'), ?)",
		v1.ChannelMode_CHANNEL_MODE_ROLES).Scan(&mode)
	return mode, err
}

// syncAccess brings text channel member lists in line with who can see what:
// it removes members who can no longer see a channel and, in ROLES mode,
// adds those who now can. joining (a member id, or "") also gets OPT_IN's
// default channels, and then only that member is checked: nothing else
// changed. Each member hears about each change with a member-scoped
// channel_deleted or channel_created.
// ponytail: role and channel changes still recompute every channel x member;
// scope those to the changed rows if communities grow past tens of thousands.
func (s *Server) syncAccess(t *wtx, joining string) error {
	ctx := t.ctx
	only, args := "", []any{}
	if joining != "" {
		only, args = " AND m.id = ?", []any{joining}
	}
	mode, err := channelMode(ctx, t)
	if err != nil {
		return err
	}
	pairs := func(query string, args ...any) ([][2]string, error) {
		rows, err := t.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][2]string
		for rows.Next() {
			var p [2]string
			if err := rows.Scan(&p[0], &p[1]); err != nil {
				return nil, err
			}
			out = append(out, p)
		}
		return out, rows.Err()
	}
	gone, err := pairs(`SELECT c.id, m.id FROM channel_members cm JOIN channels c ON c.id = cm.channel_id JOIN members m ON m.id = cm.member_id
		WHERE c.kind = ? AND NOT `+visibleSQL+only+` ORDER BY c.id, m.id`, append([]any{v1.ChannelKind_CHANNEL_KIND_TEXT}, args...)...)
	if err != nil {
		return err
	}
	for _, p := range gone {
		if err := removeFromChannel(t, p[0], p[1]); err != nil {
			return err
		}
	}
	added, err := pairs(`SELECT c.id, m.id FROM channels c JOIN members m
		WHERE c.kind = ? AND m.deleted = 0 AND (? OR (c.is_default AND m.id = ?)) AND `+visibleSQL+`
		AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.member_id = m.id)`+only+`
		ORDER BY c.id, m.id`, append([]any{v1.ChannelKind_CHANNEL_KIND_TEXT, mode == v1.ChannelMode_CHANNEL_MODE_ROLES, joining}, args...)...)
	if err != nil {
		return err
	}
	for _, p := range added {
		if err := addToTextChannel(t, p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}

// addToTextChannel stores the membership and tells the member.
func addToTextChannel(t *wtx, channelID, memberID string) error {
	if _, err := t.ExecContext(t.ctx, "INSERT OR IGNORE INTO channel_members(channel_id, member_id) VALUES (?,?)", channelID, memberID); err != nil {
		return err
	}
	cs, err := queryChannels(t.ctx, t, "id = ?", channelID)
	if err != nil {
		return err
	}
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	// Old history is not unread for a new channel member (as in AddChannelMembers).
	if _, err := t.ExecContext(t.ctx, upsertReadState, memberID, channelID, seq); err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_ChannelCreated{ChannelCreated: cs[0]}}, "", memberID)
}

func splitIDs(s sql.NullString) []string {
	if !s.Valid || s.String == "" {
		return nil
	}
	ids := strings.Split(s.String, ",")
	slices.Sort(ids)
	return ids
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

var colorRE = regexp.MustCompile(`^(#[0-9a-fA-F]{6})?$`)

const maxRoles = 250

func listRoles(ctx context.Context, q queryer) ([]*v1.Role, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, name, color, position FROM roles ORDER BY position, created_at_ms, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*v1.Role
	for rows.Next() {
		r := &v1.Role{}
		if err := rows.Scan(&r.Id, &r.Name, &r.Color, &r.Position); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func roleByID(ctx context.Context, q queryer, id string) (*v1.Role, error) {
	r := &v1.Role{}
	err := q.QueryRowContext(ctx, "SELECT id, name, color, position FROM roles WHERE id = ?", id).Scan(&r.Id, &r.Name, &r.Color, &r.Position)
	if err == sql.ErrNoRows {
		return nil, errf(connect.CodeNotFound, "role not found")
	}
	return r, err
}

func checkRole(name, color *string) error {
	if name != nil {
		*name = strings.TrimSpace(*name)
		if *name == "" {
			return errf(connect.CodeInvalidArgument, "role name is empty")
		}
		if err := checkText("name", *name, maxNameChars, true); err != nil {
			return err
		}
	}
	if color != nil && !colorRE.MatchString(*color) {
		return errf(connect.CodeInvalidArgument, "color must be #rrggbb or empty")
	}
	return nil
}

func requireAdminFor(ctx context.Context, what string) error {
	if !isAdmin(me(ctx)) {
		return errf(connect.CodePermissionDenied, "only admins can %s", what)
	}
	return nil
}

func emitRole(t *wtx, r *v1.Role) error {
	return t.emit(&v1.Event{Kind: &v1.Event_RoleUpdated{RoleUpdated: r}}, "", "")
}

func (s *Server) CreateRole(ctx context.Context, req *connect.Request[v1.CreateRoleRequest]) (*connect.Response[v1.CreateRoleResponse], error) {
	if err := requireAdminFor(ctx, "manage roles"); err != nil {
		return nil, err
	}
	r := req.Msg
	if err := checkRole(&r.Name, &r.Color); err != nil {
		return nil, err
	}
	var out *v1.Role
	err := s.writeTx(ctx, func(t *wtx) error {
		var n int32
		if err := t.QueryRowContext(ctx, "SELECT COUNT(*) FROM roles").Scan(&n); err != nil {
			return err
		}
		if n >= maxRoles {
			return errf(connect.CodeResourceExhausted, "a community can have at most %d roles", maxRoles)
		}
		now := s.now()
		out = &v1.Role{Id: newID(now), Name: r.Name, Color: r.Color}
		if err := t.QueryRowContext(ctx, `INSERT INTO roles(id, name, color, position, created_at_ms)
			VALUES (?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM roles), ?) RETURNING position`,
			out.Id, out.Name, out.Color, now.UnixMilli()).Scan(&out.Position); err != nil {
			return err
		}
		return emitRole(t, out)
	})
	if isUnique(err) {
		return nil, errf(connect.CodeAlreadyExists, "a role named %q already exists", r.Name)
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CreateRoleResponse{Role: out}), nil
}

func (s *Server) UpdateRole(ctx context.Context, req *connect.Request[v1.UpdateRoleRequest]) (*connect.Response[v1.UpdateRoleResponse], error) {
	if err := requireAdminFor(ctx, "manage roles"); err != nil {
		return nil, err
	}
	r := req.Msg
	if err := checkRole(r.Name, r.Color); err != nil {
		return nil, err
	}
	var out *v1.Role
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		if out, err = roleByID(ctx, t, r.RoleId); err != nil {
			return err
		}
		if r.Name != nil {
			out.Name = *r.Name
		}
		if r.Color != nil {
			out.Color = *r.Color
		}
		if r.Position != nil {
			out.Position = *r.Position
		}
		if _, err := t.ExecContext(ctx, "UPDATE roles SET name = ?, color = ?, position = ? WHERE id = ?", out.Name, out.Color, out.Position, out.Id); err != nil {
			return err
		}
		return emitRole(t, out)
	})
	if isUnique(err) {
		return nil, errf(connect.CodeAlreadyExists, "a role with that name already exists")
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.UpdateRoleResponse{Role: out}), nil
}

func (s *Server) DeleteRole(ctx context.Context, req *connect.Request[v1.DeleteRoleRequest]) (*connect.Response[v1.DeleteRoleResponse], error) {
	if err := requireAdminFor(ctx, "manage roles"); err != nil {
		return nil, err
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		role, err := roleByID(ctx, t, req.Msg.RoleId)
		if err != nil {
			return err
		}
		var gated string
		err = t.QueryRowContext(ctx, `SELECT c.name FROM channel_roles cr JOIN channels c ON c.id = cr.channel_id
			WHERE cr.role_id = ? ORDER BY c.name LIMIT 1`, role.Id).Scan(&gated)
		if err == nil {
			return errf(connect.CodeFailedPrecondition, "role %q still limits #%s; take it off its channels first", role.Name, gated)
		}
		if err != sql.ErrNoRows {
			return err
		}
		posted, err := scanIDs(t.QueryContext(ctx, "SELECT channel_id FROM channel_post_roles WHERE role_id = ? ORDER BY channel_id", role.Id))
		if err != nil {
			return err
		}
		// A channel that only this role posted in stays limited, to admins.
		for _, q := range []string{"INSERT OR IGNORE INTO channel_post_roles(channel_id, role_id) SELECT channel_id, 'admin' FROM channel_post_roles WHERE role_id = ?",
			"DELETE FROM channel_post_roles WHERE role_id = ?", "DELETE FROM member_roles WHERE role_id = ?", "DELETE FROM roles WHERE id = ?"} {
			if _, err := t.ExecContext(ctx, q, role.Id); err != nil {
				return err
			}
		}
		// Channels it posted in lose its id (1315); no role gates a channel, so nobody's channels change.
		for _, id := range posted {
			if _, err := emitChannelUpdated(t, id); err != nil {
				return err
			}
		}
		return t.emit(&v1.Event{Kind: &v1.Event_RoleDeleted{RoleDeleted: role.Id}}, "", "")
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeleteRoleResponse{}), nil
}

// checkRoleIDs dedupes ids and checks that every role exists.
func checkRoleIDs(ctx context.Context, q queryer, ids []string) ([]string, error) {
	var out []string
	for _, id := range ids {
		if err := checkID("role_ids", id); err != nil {
			return nil, err
		}
		if slices.Contains(out, id) {
			continue
		}
		if _, err := roleByID(ctx, q, id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

func (s *Server) SetMemberRoles(ctx context.Context, req *connect.Request[v1.SetMemberRolesRequest]) (*connect.Response[v1.SetMemberRolesResponse], error) {
	if err := requireAdminFor(ctx, "give roles"); err != nil {
		return nil, err
	}
	r := req.Msg
	var out *memberRow
	err := s.writeTx(ctx, func(t *wtx) error {
		if _, err := s.liveMember(ctx, t, me(ctx).Id); err != nil {
			return err
		}
		target, err := s.liveMember(ctx, t, r.MemberId)
		if err != nil {
			return err
		}
		ids, err := checkRoleIDs(ctx, t, r.RoleIds)
		if err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "DELETE FROM member_roles WHERE member_id = ?", target.Id); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := t.ExecContext(ctx, "INSERT INTO member_roles(member_id, role_id) VALUES (?,?)", target.Id, id); err != nil {
				return err
			}
		}
		if out, err = s.loadMember(ctx, t, "id = ?", target.Id); err != nil {
			return err
		}
		if err := t.emit(&v1.Event{Kind: &v1.Event_MemberUpdated{MemberUpdated: out.Member}}, "", ""); err != nil {
			return err
		}
		return s.syncAccess(t, "")
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("member roles set", "member", out.Id, "roles", out.RoleIds, "by", me(ctx).Id)
	return connect.NewResponse(&v1.SetMemberRolesResponse{Member: out.Member}), nil
}

// ---------------------------------------------------------------------------
// Channel access and OPT_IN membership
// ---------------------------------------------------------------------------

// Who can post (1308) works like who can see: channel_post_roles lists ids,
// and no rows means everyone. Admins and the owner always post. Besides
// custom roles, "moderator" lets moderators in and "admin" alone limits the
// channel to admins. Bots post too: only admins make them (1290). Thread
// replies, reactions and edits are not limited.

func mayPost(c *v1.Channel, m *v1.Member) bool {
	if len(c.PostRoleIds) == 0 || m.Role >= v1.MemberRole_MEMBER_ROLE_ADMIN || m.Kind == v1.MemberKind_MEMBER_KIND_BOT {
		return true
	}
	for _, id := range c.PostRoleIds {
		if id == "moderator" && m.Role >= v1.MemberRole_MEMBER_ROLE_MODERATOR || slices.Contains(m.RoleIds, id) {
			return true
		}
	}
	return false
}

// setPostRoles replaces a channel's post list after checking every id.
func setPostRoles(ctx context.Context, t *wtx, channelID string, ids []string) error {
	var ranks, custom []string
	for _, id := range ids {
		if id == "admin" || id == "moderator" {
			ranks = append(ranks, id)
		} else {
			custom = append(custom, id)
		}
	}
	custom, err := checkRoleIDs(ctx, t, custom)
	if err != nil {
		return err
	}
	if _, err := t.ExecContext(ctx, "DELETE FROM channel_post_roles WHERE channel_id = ?", channelID); err != nil {
		return err
	}
	for _, id := range append(ranks, custom...) {
		if _, err := t.ExecContext(ctx, "INSERT OR IGNORE INTO channel_post_roles(channel_id, role_id) VALUES (?,?)", channelID, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) SetChannelAccess(ctx context.Context, req *connect.Request[v1.SetChannelAccessRequest]) (*connect.Response[v1.SetChannelAccessResponse], error) {
	if err := requireAdminFor(ctx, "change who sees a channel"); err != nil {
		return nil, err
	}
	r := req.Msg
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		old, err := channelFor(ctx, t, r.ChannelId, me(ctx).Id)
		if err != nil {
			return err
		}
		if old.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
			return errf(connect.CodeInvalidArgument, "only text channels have roles; private channels have a member list")
		}
		ids, err := checkRoleIDs(ctx, t, r.RoleIds)
		if err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "DELETE FROM channel_roles WHERE channel_id = ?", old.Id); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := t.ExecContext(ctx, "INSERT INTO channel_roles(channel_id, role_id) VALUES (?,?)", old.Id, id); err != nil {
				return err
			}
		}
		if _, err := t.ExecContext(ctx, "UPDATE channels SET is_default = ? WHERE id = ?", r.IsDefault, old.Id); err != nil {
			return err
		}
		// Hide and show first, so channel_updated reaches only who can see it now.
		if err := s.syncAccess(t, ""); err != nil {
			return err
		}
		c, err = emitChannelUpdated(t, old.Id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.SetChannelAccessResponse{Channel: c}), nil
}

func (s *Server) BrowseChannels(ctx context.Context, _ *connect.Request[v1.BrowseChannelsRequest]) (*connect.Response[v1.BrowseChannelsResponse], error) {
	cs, err := queryChannels(ctx, s.db.r, "id IN (SELECT c.id FROM channels c JOIN members m ON m.id = ? WHERE c.kind = ? AND "+visibleSQL+")",
		me(ctx).Id, v1.ChannelKind_CHANNEL_KIND_TEXT)
	if err != nil {
		return nil, err
	}
	for _, c := range cs {
		if err := s.db.r.QueryRowContext(ctx, "SELECT COUNT(*) FROM channel_members WHERE channel_id = ?", c.Id).Scan(&c.MemberCount); err != nil {
			return nil, err
		}
	}
	return connect.NewResponse(&v1.BrowseChannelsResponse{Channels: cs}), nil
}

// optInTextChannel loads a text channel the caller can see, in OPT_IN mode.
func optInTextChannel(t *wtx, id string) (*v1.Channel, error) {
	mode, err := channelMode(t.ctx, t)
	if err != nil {
		return nil, err
	}
	if mode != v1.ChannelMode_CHANNEL_MODE_OPT_IN {
		return nil, errf(connect.CodeFailedPrecondition, "this community puts everyone in every channel they can see")
	}
	c, err := channelFor(t.ctx, t, id, me(t.ctx).Id)
	if err == nil && c.Kind != v1.ChannelKind_CHANNEL_KIND_TEXT {
		err = errf(connect.CodeInvalidArgument, "only text channels can be joined and left this way")
	}
	return c, err
}

func (s *Server) JoinChannel(ctx context.Context, req *connect.Request[v1.JoinChannelRequest]) (*connect.Response[v1.JoinChannelResponse], error) {
	var c *v1.Channel
	err := s.writeTx(ctx, func(t *wtx) error {
		var err error
		if c, err = optInTextChannel(t, req.Msg.ChannelId); err != nil {
			return err
		}
		var in bool
		if err := t.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = ? AND member_id = ?)", c.Id, me(ctx).Id).Scan(&in); err != nil || in {
			return err
		}
		return addToTextChannel(t, c.Id, me(ctx).Id)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.JoinChannelResponse{Channel: c}), nil
}

func (s *Server) LeaveChannel(ctx context.Context, req *connect.Request[v1.LeaveChannelRequest]) (*connect.Response[v1.LeaveChannelResponse], error) {
	err := s.writeTx(ctx, func(t *wtx) error {
		c, err := optInTextChannel(t, req.Msg.ChannelId)
		if err != nil {
			return err
		}
		return removeFromChannel(t, c.Id, me(ctx).Id)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.LeaveChannelResponse{}), nil
}

// setChannelMode switches modes; UNSPECIFIED or the current mode is a no-op.
// ROLES to OPT_IN keeps everyone in the channels they are in, which in ROLES
// mode are all they can see. OPT_IN to ROLES puts everyone in all of them.
func (s *Server) setChannelMode(t *wtx, mode v1.ChannelMode) error {
	switch mode {
	case v1.ChannelMode_CHANNEL_MODE_UNSPECIFIED:
		return nil
	case v1.ChannelMode_CHANNEL_MODE_ROLES, v1.ChannelMode_CHANNEL_MODE_OPT_IN:
	default:
		return errf(connect.CodeInvalidArgument, "unknown channel mode")
	}
	old, err := channelMode(t.ctx, t)
	if err != nil || old == mode {
		return err
	}
	if _, err := t.ExecContext(t.ctx, "INSERT INTO settings(key, value) VALUES ('channel_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		int32(mode)); err != nil {
		return err
	}
	if err := t.emit(&v1.Event{Kind: &v1.Event_ChannelModeChanged{ChannelModeChanged: mode}}, "", ""); err != nil {
		return err
	}
	return s.syncAccess(t, "")
}
