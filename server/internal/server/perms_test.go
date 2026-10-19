package server

import (
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Permission rules that the feature tests do not pin down on their own.

// A Subscribe from an old seq must not hand out what ListMessages would
// not: deleted messages, or anything from before the member joined.
func TestReplayLeaksNothingOld(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	oops := ana.send(gen.Id, "my password is hunter2")
	must(ana.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: oops.Id, Emoji: "👀"})))
	must(ana.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: oops.Id})))
	ana.send(gen.Id, "before carol")
	carol := e.join("carol")
	ana.send(gen.Id, "marker")

	for _, c := range []*client{bob, carol} {
		var seen []*v1.Event
		c.subscribe(0).next(isCreated("marker"), &seen)
		for _, ev := range seen {
			m := ev.GetMessageCreated()
			if m == nil {
				m = ev.GetMessageUpdated()
			}
			if m.GetText() == "my password is hunter2" {
				t.Fatalf("%s replayed a deleted message: %v", c.me.Username, ev)
			}
			if c == carol && m.GetText() == "before carol" {
				t.Fatalf("carol replayed an event from before she joined: %v", ev)
			}
		}
	}
}

// Nobody outside a private channel or DM may touch it, whatever their role.
func TestNonMembersCannotTouchPrivateChannels(t *testing.T) {
	e := newEnv(t)
	ana, bob, eve := e.join("ana"), e.join("bob"), e.join("eve")
	must(ana.srv.SetMemberRole(ctx(), connect.NewRequest(&v1.SetMemberRoleRequest{MemberId: eve.me.Id, Role: v1.MemberRole_MEMBER_ROLE_ADMIN})))
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	if err := ana.addTo(secret.Id, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	dm := must(ana.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{bob.me.Id}}))).Channel
	eveSub := eve.subscribe(eve.state().Seq)

	for _, ch := range []*v1.Channel{secret, dm} {
		msg := bob.send(ch.Id, "for members only")
		calls := map[string]func() error{
			"ListMessages thread": func() error {
				_, err := eve.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: ch.Id, ThreadRootId: msg.Id}))
				return err
			},
			"thread reply": func() error {
				_, err := eve.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: ch.Id, ThreadRootId: msg.Id, Text: "hi"}))
				return err
			},
			"reply via a channel she sees": func() error {
				_, err := eve.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: msg.Id, Text: "hi"}))
				return err
			},
			"React": func() error {
				_, err := eve.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: msg.Id, Emoji: "👍"}))
				return err
			},
			"EditMessage": func() error {
				_, err := eve.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: msg.Id, Text: "x"}))
				return err
			},
			"DeleteMessage": func() error {
				_, err := eve.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: msg.Id}))
				return err
			},
			"MarkRead": func() error {
				_, err := eve.chat.MarkRead(ctx(), connect.NewRequest(&v1.MarkReadRequest{ChannelId: ch.Id}))
				return err
			},
			"SetTyping": func() error {
				_, err := eve.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: ch.Id}))
				return err
			},
			"Search in channel": func() error {
				_, err := eve.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{ChannelId: ch.Id, Query: "members"}))
				return err
			},
			"JoinChannel": func() error {
				_, err := eve.chat.JoinChannel(ctx(), connect.NewRequest(&v1.JoinChannelRequest{ChannelId: ch.Id}))
				return err
			},
			"AddChannelMembers": func() error { return eve.addTo(ch.Id, eve.me.Id) },
			"RemoveChannelMember": func() error { return eve.removeFrom(ch.Id, bob.me.Id) },
			"UpdateChannel": func() error {
				topic := "mine now"
				_, err := eve.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: ch.Id, Topic: &topic}))
				return err
			},
		}
		for name, call := range calls {
			if err := call(); connect.CodeOf(err) != connect.CodeNotFound && connect.CodeOf(err) != connect.CodeFailedPrecondition {
				t.Errorf("%v %s: got %v, want not found", ch.Kind, name, err)
			}
		}
		if res := must(eve.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "members"}))); len(res.Messages) != 0 {
			t.Errorf("%v: search everywhere found %v", ch.Kind, res.Messages)
		}
		must(bob.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: ch.Id})))
	}
	ana.send(gen.Id, "marker")
	var seen []*v1.Event
	eveSub.next(isCreated("marker"), &seen)
	for _, ev := range seen {
		if id := ev.GetTyping().GetChannelId() + ev.GetMessageCreated().GetChannelId() + ev.GetMessageUpdated().GetChannelId(); id == secret.Id || id == dm.Id {
			t.Fatalf("eve received %v", ev)
		}
	}
}

// Members and moderators get PERMISSION_DENIED from admin-only calls;
// admins get past the check.
func TestAdminOnlyCalls(t *testing.T) {
	e := newEnv(t)
	ana, mem, mod, adm := e.join("ana"), e.join("mem"), e.join("mod"), e.join("adm")
	for _, x := range []struct {
		c    *client
		role v1.MemberRole
	}{{mod, v1.MemberRole_MEMBER_ROLE_MODERATOR}, {adm, v1.MemberRole_MEMBER_ROLE_ADMIN}} {
		if err := ana.setRole(x.c.me.Id, x.role); err != nil {
			t.Fatal(err)
		}
	}
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	on := true
	calls := map[string]func(c *client) error{
		"CreateChannel": func(c *client) error {
			_, err := c.chat.CreateChannel(ctx(), connect.NewRequest(&v1.CreateChannelRequest{Name: "new-" + c.me.Username}))
			return err
		},
		"SetChannelAccess": func(c *client) error {
			_, err := c.chat.SetChannelAccess(ctx(), connect.NewRequest(&v1.SetChannelAccessRequest{ChannelId: gen.Id}))
			return err
		},
		"CreateRole": func(c *client) error {
			_, err := c.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "r-" + c.me.Username}))
			return err
		},
		"CreateInvite": func(c *client) error {
			_, err := c.srv.CreateInvite(ctx(), connect.NewRequest(&v1.CreateInviteRequest{}))
			return err
		},
		"ListInvites": func(c *client) error {
			_, err := c.srv.ListInvites(ctx(), connect.NewRequest(&v1.ListInvitesRequest{}))
			return err
		},
		"UpdateServerSettings": func(c *client) error {
			_, err := c.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{InviteOnly: &on}))
			return err
		},
		"CreateBot": func(c *client) error {
			_, err := c.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "bot-" + c.me.Username}))
			return err
		},
		"ListPlugins": func(c *client) error {
			_, err := c.bots.ListPlugins(ctx(), connect.NewRequest(&v1.ListPluginsRequest{}))
			return err
		},
		"SetMemberRole": func(c *client) error { return c.setRole(mem.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR) },
	}
	for name, call := range calls {
		for _, c := range []*client{mem, mod} {
			if err := call(c); connect.CodeOf(err) != connect.CodePermissionDenied {
				t.Errorf("%s as %s: got %v, want permission denied", name, c.me.Username, err)
			}
		}
		if err := call(adm); err != nil {
			t.Errorf("%s as admin: %v", name, err)
		}
	}
}

// A banned person stays out even with a valid invite.
func TestBannedCannotUseInvite(t *testing.T) {
	e := newEnv(t)
	ana, dee := e.join("ana"), e.join("dee")
	on := true
	must(ana.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{InviteOnly: &on})))
	inv := must(ana.srv.CreateInvite(ctx(), connect.NewRequest(&v1.CreateInviteRequest{}))).Invite
	must(ana.srv.BanMember(ctx(), connect.NewRequest(&v1.BanMemberRequest{MemberId: dee.me.Id})))
	_, err := dee.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{InviteCode: inv.Code}))
	wantCode(t, err, connect.CodePermissionDenied)
}

// Many people joining an empty community at once make exactly one owner.
func TestFirstJoinerRace(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	roles := make([]v1.MemberRole, 8)
	for i := range roles {
		wg.Go(func() {
			c := e.client(e.token(string(rune('a'+i)) + "x"))
			res, err := c.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))
			if err != nil {
				t.Error(err)
				return
			}
			roles[i] = res.Msg.Member.Role
		})
	}
	wg.Wait()
	owners := 0
	for _, r := range roles {
		if r == v1.MemberRole_MEMBER_ROLE_OWNER {
			owners++
		}
	}
	if owners != 1 {
		t.Fatalf("roles = %v, want exactly one owner", roles)
	}
}

// An edit rewrites the message's earlier events, so a replay from an old
// seq shows the current text and never the text before the edit (1122).
func TestReplayHasNoPreEditText(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	oops := ana.send(gen.Id, "my password is hunter2")
	must(ana.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: oops.Id, Emoji: "👀"})))
	must(ana.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: oops.Id, Text: "never mind"})))
	ana.send(gen.Id, "marker")

	var seen []*v1.Event
	bob.subscribe(0).next(isCreated("marker"), &seen)
	created := false
	for _, ev := range seen {
		m := ev.GetMessageCreated()
		if m == nil {
			m = ev.GetMessageUpdated()
		}
		if m.GetText() == "my password is hunter2" {
			t.Fatalf("replayed pre-edit text: %v", ev)
		}
		if ev.GetMessageCreated().GetId() == oops.Id {
			created = true
			if m.EditedAtMs == 0 {
				t.Fatalf("rewritten message_created lost edited_at: %v", ev)
			}
		}
	}
	if !created {
		t.Fatal("the edited message's message_created must still replay")
	}
}
