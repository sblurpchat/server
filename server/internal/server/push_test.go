package server

import (
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestPushCandidates(t *testing.T) {
	for _, c := range []struct {
		dm        bool
		text      string
		dmMembers []string
		want      []string
		wantKind  string
	}{
		{false, "hi <@b> and <@c>, <@b> again", nil, []string{"b", "c"}, "mention"},
		{false, "hi <@me>", nil, []string{}, "mention"},
		{false, "hi @b <@> <b> <@b c>", nil, []string{}, "mention"},
		{true, "no mentions", []string{"me", "b", "c"}, []string{"b", "c"}, "dm"},
		{true, "<@d> in a dm", []string{"b", "me"}, []string{"b"}, "dm"},
	} {
		ids, kind := pushCandidates(c.dm, c.text, "me", c.dmMembers)
		if kind != c.wantKind || !slices.Equal(ids, c.want) {
			t.Errorf("%q: %v %s, want %v %s", c.text, ids, kind, c.want, c.wantKind)
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
