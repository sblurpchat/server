package server

import (
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func (c *client) setAccess(channel string, def bool, roles ...string) error {
	_, err := c.chat.SetChannelAccess(ctx(), connect.NewRequest(&v1.SetChannelAccessRequest{ChannelId: channel, RoleIds: roles, IsDefault: def}))
	return err
}

func (c *client) giveRoles(member string, roles ...string) error {
	_, err := c.srv.SetMemberRoles(ctx(), connect.NewRequest(&v1.SetMemberRolesRequest{MemberId: member, RoleIds: roles}))
	return err
}

func (c *client) setMode(m v1.ChannelMode) {
	c.e.t.Helper()
	if got := must(c.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{ChannelMode: m}))).ChannelMode; got != m {
		c.e.t.Fatalf("mode = %v, want %v", got, m)
	}
}

func (c *client) browse() []string {
	var ids []string
	for _, ch := range must(c.chat.BrowseChannels(ctx(), connect.NewRequest(&v1.BrowseChannelsRequest{}))).Channels {
		ids = append(ids, ch.Id)
	}
	return ids
}

func (c *client) browseCount(id string) int32 {
	for _, ch := range must(c.chat.BrowseChannels(ctx(), connect.NewRequest(&v1.BrowseChannelsRequest{}))).Channels {
		if ch.Id == id {
			return ch.MemberCount
		}
	}
	return -1
}

func (c *client) joinChannel(id string) error {
	_, err := c.chat.JoinChannel(ctx(), connect.NewRequest(&v1.JoinChannelRequest{ChannelId: id}))
	return err
}

func (c *client) leaveChannel(id string) error {
	_, err := c.chat.LeaveChannel(ctx(), connect.NewRequest(&v1.LeaveChannelRequest{ChannelId: id}))
	return err
}

func (c *client) search(q, channel string) ([]*v1.Message, error) {
	res, err := c.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: q, ChannelId: channel}))
	if err != nil {
		return nil, err
	}
	return res.Msg.Messages, nil
}

func isChannelCreated(id string) func(*v1.Event) bool {
	return func(ev *v1.Event) bool { return ev.GetChannelCreated().GetId() == id }
}

func isChannelDeleted(id string) func(*v1.Event) bool {
	return func(ev *v1.Event) bool { return ev.GetChannelDeleted() == id }
}

// noLeak fails if any event mentions one of ids. channel_deleted is allowed
// (it is how a member hears that a channel went away), and with membership
// set so is channel_created (a replay holds the member's own history).
func noLeak(t *testing.T, who string, evs []*v1.Event, membership bool, ids ...string) {
	t.Helper()
	for _, ev := range evs {
		if ev.GetChannelDeleted() != "" || (membership && ev.GetChannelCreated() != nil) {
			continue
		}
		js := protojson.Format(ev)
		for _, id := range ids {
			if strings.Contains(js, id) {
				t.Fatalf("%s got an event about %s: %s", who, id, js)
			}
		}
	}
}

// TestChannelModesAndRoles checks that a member never gets an event,
// message, search hit or file URL of a text channel they cannot see, in
// either channel mode, including right after a role, rank or mode change.
func TestChannelModesAndRoles(t *testing.T) {
	e := newEnv(t)
	ana, joe, fan, mo := e.join("ana"), e.join("joe"), e.join("fan"), e.join("mo") // ana owns
	if err := ana.setRole(mo.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR); err != nil {
		t.Fatal(err)
	}
	if st := joe.state(); st.ChannelMode != v1.ChannelMode_CHANNEL_MODE_ROLES {
		t.Fatalf("default mode = %v", st.ChannelMode)
	}
	gen := ana.channel("gen", v1.ChannelKind_CHANNEL_KIND_TEXT)
	film := ana.channel("film", v1.ChannelKind_CHANNEL_KIND_TEXT)
	priv := ana.channel("priv", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	if !joe.inState(gen.Id) || !joe.inState(film.Id) {
		t.Fatal("ROLES: an ungated channel is in everyone's sidebar")
	}

	// Validation and permissions.
	_, err := joe.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Mine"}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = mo.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Mine"}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Red", Color: "red"}))
	wantCode(t, err, connect.CodeInvalidArgument)
	_, err = ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "two\nlines"}))
	wantCode(t, err, connect.CodeInvalidArgument)
	_, err = ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "  "}))
	wantCode(t, err, connect.CodeInvalidArgument)
	role := must(ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Film club", Color: "#aa0000"}))).Role
	other := must(ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Other"}))).Role
	if role.Position != 0 || other.Position != 1 {
		t.Fatalf("positions %d %d", role.Position, other.Position)
	}
	_, err = ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "film CLUB"}))
	wantCode(t, err, connect.CodeAlreadyExists)
	wantCode(t, ana.giveRoles(joe.me.Id, "nope"), connect.CodeNotFound)
	wantCode(t, joe.giveRoles(joe.me.Id, role.Id), connect.CodePermissionDenied)
	wantCode(t, mo.setAccess(film.Id, false, role.Id), connect.CodePermissionDenied)
	wantCode(t, ana.setAccess(priv.Id, false, role.Id), connect.CodeInvalidArgument)
	wantCode(t, ana.setAccess(film.Id, false, "nope"), connect.CodeNotFound)

	// Gate #film. fan has the role, joe and mo (a moderator) do not.
	if err := ana.giveRoles(fan.me.Id, role.Id, role.Id); err != nil {
		t.Fatal(err)
	}
	if got := fan.state().Me.RoleIds; !slices.Equal(got, []string{role.Id}) {
		t.Fatalf("fan's roles = %v", got)
	}
	joeSub, moSub := joe.subscribe(joe.state().Seq), mo.subscribe(mo.state().Seq)
	if err := ana.setAccess(film.Id, false, role.Id); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelDeleted(film.Id), nil)
	moSub.next(isChannelDeleted(film.Id), nil)

	_, att := ana.upload("poster.png", pngBytes(4, 4))
	secret := must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: film.Id, Text: "reel talk", AttachmentIds: []string{att.Id}}))).Message
	must(ana.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: secret.Id, Emoji: "🎬"})))
	must(ana.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: secret.Id, Text: "reel talk!"})))
	must(ana.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: film.Id})))
	must(ana.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: film.Id, Topic: new("Fridays")})))

	// sync sends a marker in #gen and returns what w saw up to it.
	n := 0
	sync := func(w *subscription) []*v1.Event {
		t.Helper()
		n++
		mark := "marker " + strings.Repeat("x", n)
		e.clock.Advance(3 * time.Second) // refill ana's send budget
		ana.send(gen.Id, mark)
		var seen []*v1.Event
		w.next(isCreated(mark), &seen)
		return seen
	}
	cannotSee := func(c *client, who, channel, text string, msgID string) {
		t.Helper()
		if c.inState(channel) || slices.Contains(c.browse(), channel) {
			t.Fatalf("%s: channel in state or browse", who)
		}
		_, err := c.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: channel}))
		wantCode(t, err, connect.CodeNotFound)
		_, err = c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: channel, Text: "hi"}))
		wantCode(t, err, connect.CodeNotFound)
		_, err = c.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: channel}))
		wantCode(t, err, connect.CodeNotFound)
		if msgID != "" {
			_, err = c.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: msgID, Emoji: "👍"}))
			wantCode(t, err, connect.CodeNotFound)
		}
		if ms, err := c.search(text, ""); err != nil || len(ms) != 0 {
			t.Fatalf("%s: search found %v %v", who, ms, err)
		}
		_, err = c.search(text, channel)
		wantCode(t, err, connect.CodeNotFound)
	}
	noLeak(t, "joe", sync(joeSub), false, film.Id, secret.Id, att.Id)
	noLeak(t, "mo", sync(moSub), false, film.Id, secret.Id, att.Id)
	cannotSee(joe, "joe", film.Id, "reel", secret.Id)
	cannotSee(mo, "mo", film.Id, "reel", secret.Id)
	wantCode(t, joe.joinChannel(film.Id), connect.CodeFailedPrecondition) // ROLES has no joining
	if ms, err := fan.search("reel", ""); err != nil || len(ms) != 1 || len(ms[0].Attachments) != 1 {
		t.Fatalf("fan's search = %v %v", ms, err)
	}
	if ms := must(fan.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: film.Id}))).Messages; len(ms) != 1 {
		t.Fatalf("fan lists %v", ms)
	}

	// Bots can have roles too.
	bot := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"})))
	if e.client(bot.Token).inState(film.Id) {
		t.Fatal("bot without the role sees #film")
	}
	if err := ana.giveRoles(bot.Bot.Id, role.Id); err != nil {
		t.Fatal(err)
	}
	if !e.client(bot.Token).inState(film.Id) {
		t.Fatal("bot with the role cannot see #film")
	}

	// Giving joe the role shows #film at once; taking it hides it at once.
	if err := ana.giveRoles(joe.me.Id, role.Id); err != nil {
		t.Fatal(err)
	}
	if ev := joeSub.next(isChannelCreated(film.Id), nil); !slices.Equal(ev.GetChannelCreated().RoleIds, []string{role.Id}) {
		t.Fatalf("channel_created = %v", ev)
	}
	ana.send(film.Id, "welcome joe")
	joeSub.next(isCreated("welcome joe"), nil)
	if ms, _ := joe.search("reel", ""); len(ms) != 1 {
		t.Fatalf("joe with the role found %v", ms)
	}
	if err := ana.giveRoles(joe.me.Id); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelDeleted(film.Id), nil)
	ana.send(film.Id, "joe is gone")
	noLeak(t, "joe", sync(joeSub), false, film.Id)
	cannotSee(joe, "joe", film.Id, "reel", secret.Id)
	// A full replay holds no #film traffic either.
	noLeak(t, "joe replay", sync(joe.subscribe(0)), true, film.Id, secret.Id, att.Id)

	// Rank: admins see every channel; a demotion hides it again.
	if err := ana.setRole(joe.me.Id, v1.MemberRole_MEMBER_ROLE_ADMIN); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelCreated(film.Id), nil)
	if err := ana.setRole(joe.me.Id, v1.MemberRole_MEMBER_ROLE_MEMBER); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelDeleted(film.Id), nil)
	ana.send(film.Id, "demoted")
	noLeak(t, "joe", sync(joeSub), false, film.Id)
	cannotSee(joe, "joe", film.Id, "demoted", "")

	// Switch to OPT_IN: everyone keeps the channels they are in.
	fanSub := fan.subscribe(fan.state().Seq)
	ana.setMode(v1.ChannelMode_CHANNEL_MODE_OPT_IN)
	if ev := joeSub.next(func(ev *v1.Event) bool { return ev.GetChannelModeChanged() != 0 }, nil); ev.GetChannelModeChanged() != v1.ChannelMode_CHANNEL_MODE_OPT_IN {
		t.Fatalf("mode event = %v", ev)
	}
	if st := joe.state(); st.ChannelMode != v1.ChannelMode_CHANNEL_MODE_OPT_IN || !joe.inState(gen.Id) || !fan.inState(film.Id) {
		t.Fatal("OPT_IN switch must keep memberships")
	}
	wantCode(t, joe.joinChannel(film.Id), connect.CodeNotFound) // still cannot see it

	// A new channel is browsable but not joined.
	fresh := ana.channel("fresh", v1.ChannelKind_CHANNEL_KIND_TEXT)
	ana.send(fresh.Id, "fresh news")
	noLeak(t, "joe", sync(joeSub), false, fresh.Id)
	if joe.inState(fresh.Id) || !slices.Contains(joe.browse(), fresh.Id) || slices.Contains(joe.browse(), film.Id) {
		t.Fatal("OPT_IN: a new channel is browsable, not joined")
	}
	if ms, _ := joe.search("fresh", ""); len(ms) != 0 {
		t.Fatalf("search everywhere covers only joined channels, found %v", ms)
	}
	if ms, err := joe.search("fresh", fresh.Id); err != nil || len(ms) != 1 {
		t.Fatalf("search in a visible channel = %v %v", ms, err)
	}
	before := joe.browseCount(fresh.Id)
	if err := joe.joinChannel(fresh.Id); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelCreated(fresh.Id), nil)
	if err := joe.joinChannel(fresh.Id); err != nil { // joining twice is fine
		t.Fatal(err)
	}
	if n := joe.browseCount(fresh.Id); before < 0 || n != before+1 {
		t.Fatalf("browse member_count %d -> %d after joining", before, n)
	}
	ana.send(fresh.Id, "hello joiner")
	joeSub.next(isCreated("hello joiner"), nil)
	if rs := readStateFor(joe.state(), fresh.Id); rs == nil || rs.UnreadCount != 2 {
		t.Fatalf("joe's read state = %v", rs)
	}
	if err := joe.leaveChannel(fresh.Id); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelDeleted(fresh.Id), nil)
	if n := joe.browseCount(fresh.Id); n != before {
		t.Fatalf("browse member_count = %d after leaving, want %d", n, before)
	}
	ana.send(fresh.Id, "after leaving")
	noLeak(t, "joe", sync(joeSub), false, fresh.Id)
	if joe.inState(fresh.Id) || readStateFor(joe.state(), fresh.Id) != nil {
		t.Fatal("a left channel has no sidebar entry or unread count")
	}
	wantCode(t, joe.leaveChannel(priv.Id), connect.CodeNotFound)

	// OPT_IN role changes: losing the role leaves the channel; getting it
	// back makes it browsable, not joined.
	if err := ana.giveRoles(fan.me.Id); err != nil {
		t.Fatal(err)
	}
	fanSub.next(isChannelDeleted(film.Id), nil)
	ana.send(film.Id, "fan is out")
	noLeak(t, "fan", sync(fanSub), false, film.Id)
	wantCode(t, fan.joinChannel(film.Id), connect.CodeNotFound)
	cannotSee(fan, "fan", film.Id, "reel", secret.Id)
	if err := ana.giveRoles(fan.me.Id, role.Id); err != nil {
		t.Fatal(err)
	}
	if fan.inState(film.Id) || !slices.Contains(fan.browse(), film.Id) {
		t.Fatal("OPT_IN: a newly visible channel is browsable, not joined")
	}
	if err := fan.joinChannel(film.Id); err != nil {
		t.Fatal(err)
	}

	// Default channels: a new member joins them; an existing one does not.
	if err := ana.setAccess(fresh.Id, true); err != nil {
		t.Fatal(err)
	}
	noLeak(t, "joe", sync(joeSub), false, fresh.Id)
	neo := e.join("neo")
	if st := neo.state(); len(st.Channels) != 1 || st.Channels[0].Id != fresh.Id || !st.Channels[0].IsDefault {
		t.Fatalf("neo's channels = %v", st.Channels)
	}
	// A default channel neo cannot see is not joined.
	if err := ana.setAccess(film.Id, true, role.Id); err != nil {
		t.Fatal(err)
	}
	if err := e.client(e.token("neo")).leaveChannel(fresh.Id); err != nil {
		t.Fatal(err)
	}
	if neo.inState(film.Id) || neo.inState(fresh.Id) {
		t.Fatal("neo is in a channel he left or cannot see")
	}

	// Rank in OPT_IN: an admin may browse and join #film; a demotion
	// takes them out.
	if err := ana.setRole(joe.me.Id, v1.MemberRole_MEMBER_ROLE_ADMIN); err != nil {
		t.Fatal(err)
	}
	if joe.inState(film.Id) || joe.joinChannel(film.Id) != nil {
		t.Fatal("admin in OPT_IN: browsable, joinable, not auto-joined")
	}
	joeSub.next(isChannelCreated(film.Id), nil)
	if err := ana.setRole(joe.me.Id, v1.MemberRole_MEMBER_ROLE_MEMBER); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelDeleted(film.Id), nil)
	ana.send(film.Id, "joe demoted again")
	noLeak(t, "joe", sync(joeSub), false, film.Id)

	// Back to ROLES: everyone is in everything they can see.
	ana.setMode(v1.ChannelMode_CHANNEL_MODE_ROLES)
	joeSub.next(isChannelCreated(fresh.Id), nil)
	if !neo.inState(fresh.Id) || neo.inState(film.Id) || joe.inState(film.Id) {
		t.Fatal("ROLES switch puts members in every visible channel, and only those")
	}
	wantCode(t, joe.leaveChannel(fresh.Id), connect.CodeFailedPrecondition)

	// Roles: update, and delete only once no channel uses it.
	up := must(ana.srv.UpdateRole(ctx(), connect.NewRequest(&v1.UpdateRoleRequest{RoleId: role.Id, Name: new("Cinema"), Color: new(""), Position: new(int32(5))}))).Role
	if up.Name != "Cinema" || up.Color != "" || up.Position != 5 {
		t.Fatalf("updated role = %v", up)
	}
	if ev := joeSub.next(func(ev *v1.Event) bool { return ev.GetRoleUpdated() != nil }, nil); ev.GetRoleUpdated().Name != "Cinema" {
		t.Fatalf("role_updated = %v", ev)
	}
	_, err = ana.srv.UpdateRole(ctx(), connect.NewRequest(&v1.UpdateRoleRequest{RoleId: role.Id, Name: new("other")}))
	wantCode(t, err, connect.CodeAlreadyExists)
	if got := joe.state().Roles; len(got) != 2 || got[0].Id != other.Id || got[1].Name != "Cinema" {
		t.Fatalf("roles in state = %v", got)
	}
	_, err = ana.srv.DeleteRole(ctx(), connect.NewRequest(&v1.DeleteRoleRequest{RoleId: role.Id}))
	wantCode(t, err, connect.CodeFailedPrecondition)
	if err := ana.setAccess(film.Id, false); err != nil {
		t.Fatal(err)
	}
	joeSub.next(isChannelCreated(film.Id), nil) // ungated: everyone again
	must(ana.srv.DeleteRole(ctx(), connect.NewRequest(&v1.DeleteRoleRequest{RoleId: role.Id})))
	if ev := joeSub.next(func(ev *v1.Event) bool { return ev.GetRoleDeleted() != "" }, nil); ev.GetRoleDeleted() != role.Id {
		t.Fatalf("role_deleted = %v", ev)
	}
	if got := fan.state().Me.RoleIds; len(got) != 0 {
		t.Fatalf("fan still has %v", got)
	}

	// Leaving the community drops roles, so coming back does not restore access.
	if err := ana.giveRoles(fan.me.Id, other.Id); err != nil {
		t.Fatal(err)
	}
	if err := ana.setAccess(film.Id, false, other.Id); err != nil {
		t.Fatal(err)
	}
	must(fan.srv.LeaveCommunity(ctx(), connect.NewRequest(&v1.LeaveCommunityRequest{})))
	back := e.join("fan")
	if len(back.me.RoleIds) != 0 || back.inState(film.Id) {
		t.Fatalf("rejoined fan kept roles %v or #film", back.me.RoleIds)
	}
}
