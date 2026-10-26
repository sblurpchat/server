package server

import (
	"maps"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestPushCandidates(t *testing.T) {
	for _, c := range []struct {
		dm                   bool
		text                 string
		dmMembers, followers []string
		want                 map[string]string
	}{
		{false, "hi <@b> and <@c>, <@b> again", nil, nil, map[string]string{"b": "mention", "c": "mention"}},
		{false, "hi <@me>", nil, nil, map[string]string{}},
		{false, "hi @b <@> <b> <@b c>", nil, nil, map[string]string{}},
		{true, "no mentions", []string{"me", "b", "c"}, nil, map[string]string{"b": "dm", "c": "dm"}},
		{true, "<@d> in a dm", []string{"b", "me"}, []string{"x"}, map[string]string{"b": "dm"}},
		// Followers (channel set to ALL, 1515) get every message; a mention says so instead.
		{false, "hi <@b>", nil, []string{"b", "f", "me"}, map[string]string{"b": "mention", "f": "message"}},
	} {
		if got := pushCandidates(c.dm, c.text, "me", c.dmMembers, c.followers); !maps.Equal(got, c.want) {
			t.Errorf("%q: %v, want %v", c.text, got, c.want)
		}
	}
}

func TestEffectiveLevel(t *testing.T) {
	const u, all, men, no = v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED, v1.NotifyLevel_NOTIFY_LEVEL_ALL, v1.NotifyLevel_NOTIFY_LEVEL_MENTIONS, v1.NotifyLevel_NOTIFY_LEVEL_NOTHING
	for _, c := range []struct {
		own, community v1.NotifyLevel
		dm             bool
		want           v1.NotifyLevel
	}{
		{u, u, false, all},
		{u, men, false, men},
		{u, no, false, no},
		{all, no, false, all},
		{men, no, false, men},
		{u, u, true, all},
		{u, men, true, all}, // DMs skip a MENTIONS community
		{u, no, true, no},   // but not NOTHING (1515)
		{all, no, true, all},
		{no, u, true, no},
	} {
		if got := effectiveLevel(c.own, c.community, c.dm); got != c.want {
			t.Errorf("effectiveLevel(%v, %v, dm=%v) = %v, want %v", c.own, c.community, c.dm, got, c.want)
		}
	}
}

func TestPushSender(t *testing.T) {
	e := newEnv(t)
	pushToken := func(sub, handle string, preview bool) string {
		c := e.claims(sub)
		c["push"], c["push_preview"] = handle, preview
		return signJWT(e.iss.key, map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": e.iss.kid}, c)
	}
	bob := e.join("bob") // first: the owner, who can make channels
	ana, eve := e.join("ana"), e.join("eve")
	as := func(c *client, tok string) *client {
		n := e.client(tok)
		n.me = c.me
		n.state() // any call stores the push claims
		return n
	}
	ana = as(ana, pushToken("ana", "h-ana", false))
	var stored string
	e.s.db.r.QueryRow("SELECT push_handle FROM members WHERE id = ?", ana.me.Id).Scan(&stored)
	if stored != "h-ana" {
		t.Fatalf("handle not stored: %q", stored)
	}
	gen := bob.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)

	next := func() pushBody {
		t.Helper()
		select {
		case b := <-e.iss.pushes:
			return b
		case <-time.After(5 * time.Second):
			t.Fatal("no push")
			return pushBody{}
		}
	}
	// nothingBefore checks that no push came, using a marker: pushes go out
	// in order, so the next one must be the marker's.
	nothingBefore := func(why string) {
		t.Helper()
		m := eve.send(gen.Id, "<@"+ana.me.Id+"> marker")
		if b := next(); b.MessageID != m.Id {
			t.Fatalf("%s: got a push for %s", why, b.MessageID)
		}
	}

	m := bob.send(gen.Id, "secret plans for <@"+ana.me.Id+">")
	b := next()
	if b != (pushBody{Handle: "h-ana", Kind: "mention", Community: "Test", Channel: "general", ChannelID: gen.Id, MessageID: m.Id}) {
		t.Fatalf("mention push: %+v", b)
	}
	bob.send(gen.Id, "no mention here")
	nothingBefore("message without a mention")
	ana.send(gen.Id, "talking to <@"+ana.me.Id+">")
	nothingBefore("own message")
	bob.send(gen.Id, "<@"+eve.me.Id+"> has no handle")
	nothingBefore("member without a handle")

	// A member with an open stream gets no push.
	sub := ana.subscribe(ana.state().Seq)
	waitFor(t, func() bool { return e.s.hub.isOnline(ana.me.Id) })
	bob.send(gen.Id, "<@"+ana.me.Id+"> online")
	as(bob, pushToken("bob", "h-bob", false))
	eve.send(gen.Id, "<@"+bob.me.Id+"> sync") // bob's push means ana's turn has passed
	if b := next(); b.Handle != "h-bob" {
		t.Fatalf("pushed to an online member: %+v", b)
	}
	sub.cancel()
	waitFor(t, func() bool { return !e.s.hub.isOnline(ana.me.Id) })

	// Mentions in channels the member cannot see.
	secret := bob.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	bob.send(secret.Id, "<@"+ana.me.Id+"> cannot see this")
	nothingBefore("private channel")

	// DMs notify without a mention.
	dm := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{ana.me.Id}}))).Channel
	m = bob.send(dm.Id, "psst")
	if b := next(); b.Kind != "dm" || b.ChannelID != dm.Id || b.MessageID != m.Id || b.Text != "" || b.From != "" {
		t.Fatalf("dm push: %+v", b)
	}

	// Muted and blocked authors.
	must(ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: bob.me.Id})))
	bob.send(gen.Id, "<@"+ana.me.Id+"> muted")
	nothingBefore("muted author")
	must(ana.srv.UnmuteMember(ctx(), connect.NewRequest(&v1.UnmuteMemberRequest{MemberId: bob.me.Id})))
	must(ana.srv.BlockMember(ctx(), connect.NewRequest(&v1.BlockMemberRequest{MemberId: bob.me.Id})))
	bob.send(gen.Id, "<@"+ana.me.Id+"> blocked")
	nothingBefore("blocked author")
	must(ana.srv.UnblockMember(ctx(), connect.NewRequest(&v1.UnblockMemberRequest{MemberId: bob.me.Id})))

	// Notification levels (1498): NOTHING on the channel or the community
	// stops pushes; MENTIONS keeps them; a channel's own level wins. A
	// community NOTHING silences DMs too unless the DM has its own level (1515).
	level := func(ch string, l v1.NotifyLevel) {
		must(ana.srv.SetNotifyLevel(ctx(), connect.NewRequest(&v1.SetNotifyLevelRequest{ChannelId: ch, Level: l})))
	}
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_NOTHING)
	bob.send(gen.Id, "<@"+ana.me.Id+"> channel silenced")
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED) // so the marker gets through
	nothingBefore("channel level NOTHING")
	level("", v1.NotifyLevel_NOTIFY_LEVEL_NOTHING)
	bob.send(gen.Id, "<@"+ana.me.Id+"> community silenced")
	bob.send(dm.Id, "dm silenced too")
	level(dm.Id, v1.NotifyLevel_NOTIFY_LEVEL_ALL)
	m = bob.send(dm.Id, "dm's own level wins")
	if b := next(); b.MessageID != m.Id {
		t.Fatalf("community level NOTHING: got %+v", b)
	}
	level(dm.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED)
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_MENTIONS)
	m = bob.send(gen.Id, "<@"+ana.me.Id+"> channel overrides")
	if b := next(); b.MessageID != m.Id {
		t.Fatalf("channel MENTIONS under community NOTHING: got %+v", b)
	}
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED)
	level("", v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED)

	// A channel set to ALL pushes every message (1515), but not thread
	// replies, the member's own messages, or after they lose access.
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_ALL)
	m = bob.send(gen.Id, "plain message")
	if b := next(); b.Kind != "message" || b.MessageID != m.Id || b.Handle != "h-ana" {
		t.Fatalf("ALL channel push: %+v", b)
	}
	m = bob.send(gen.Id, "<@"+ana.me.Id+"> mentioned")
	if b := next(); b.Kind != "mention" || b.MessageID != m.Id {
		t.Fatalf("ALL channel mention: %+v", b)
	}
	must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: m.Id, Text: "a reply"})))
	nothingBefore("thread reply in an ALL channel") // the marker mentions ana, so it pushes once
	ana.send(gen.Id, "my own")
	m = bob.send(gen.Id, "after mine")
	if b := next(); b.MessageID != m.Id {
		t.Fatalf("own message pushed: %+v", b)
	}
	must(ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: bob.me.Id})))
	bob.send(gen.Id, "muted in an ALL channel")
	nothingBefore("muted author in an ALL channel") // pushes are checked when sent, so unmute after
	must(ana.srv.UnmuteMember(ctx(), connect.NewRequest(&v1.UnmuteMemberRequest{MemberId: bob.me.Id})))
	level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED)

	// Snooze (1515): nothing pushes until it ends.
	snooze := func(until int64) {
		must(ana.srv.SnoozeNotifications(ctx(), connect.NewRequest(&v1.SnoozeNotificationsRequest{Until: until})))
	}
	wantCode(t, func() error {
		_, err := ana.srv.SnoozeNotifications(ctx(), connect.NewRequest(&v1.SnoozeNotificationsRequest{Until: -1}))
		return err
	}(), connect.CodeInvalidArgument)
	until := e.clock.Now().Add(time.Hour).UnixMilli()
	snooze(until)
	if st := ana.state(); st.SnoozeUntil != until {
		t.Fatalf("snooze_until = %d, want %d", st.SnoozeUntil, until)
	}
	bob.send(gen.Id, "<@"+ana.me.Id+"> snoozed")
	bob.send(dm.Id, "snoozed dm")
	eve.send(gen.Id, "<@"+bob.me.Id+"> sync") // bob's push means ana's turn has passed
	if b := next(); b.Handle != "h-bob" {
		t.Fatalf("pushed while snoozed: %+v", b)
	}
	snooze(e.clock.Now().Add(-time.Minute).UnixMilli()) // a past time is no snooze
	nothingBefore("snooze over")
	snooze(0)

	// Opted in: sender and text, with mentions as usernames.
	ana = as(ana, pushToken("ana", "h-ana", true))
	m = bob.send(gen.Id, "<@"+ana.me.Id+"> look at <@"+eve.me.Id+">")
	if b := next(); b.From != "Bob" || b.Text != "@ana look at @eve" || b.MessageID != m.Id {
		t.Fatalf("preview push: %+v", b)
	}
	// A token without push claims (an agent's) keeps the handle.
	as(ana, e.token("ana"))
	m = bob.send(gen.Id, "<@"+ana.me.Id+"> still")
	if b := next(); b.MessageID != m.Id || b.Handle != "h-ana" {
		t.Fatalf("handle lost: %+v", b)
	}

	// The relay says no devices: the handle is forgotten until a token brings one.
	e.iss.pushStatus.Store(410)
	bob.send(gen.Id, "<@"+ana.me.Id+"> gone")
	next()
	waitFor(t, func() bool {
		e.s.db.r.QueryRow("SELECT push_handle FROM members WHERE id = ?", ana.me.Id).Scan(&stored)
		return stored == ""
	})
	e.iss.pushStatus.Store(0)
	bob.send(gen.Id, "<@"+ana.me.Id+"> nobody home")
	select {
	case b := <-e.iss.pushes:
		t.Fatalf("pushed to a forgotten handle: %+v", b)
	case <-time.After(200 * time.Millisecond):
	}
	ana.state()
	nothingBefore("handle back")
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for range 500 {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
