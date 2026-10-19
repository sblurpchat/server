package server

import (
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Joining a channel (OPT_IN, or a role that shows it) does not make its old
// history unread, the same as AddChannelMembers.
func TestJoinedChannelHistoryIsRead(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	bob := e.join("bob")
	ana.setMode(v1.ChannelMode_CHANNEL_MODE_OPT_IN)
	film := ana.channel("film", v1.ChannelKind_CHANNEL_KIND_TEXT)
	for _, s := range []string{"one", "two", "three"} {
		ana.send(film.Id, s)
	}
	if err := bob.joinChannel(film.Id); err != nil {
		t.Fatal(err)
	}
	if rs := readStateFor(bob.state(), film.Id); rs == nil || rs.UnreadCount != 0 {
		t.Fatalf("after join: %v, want 0 unread", rs)
	}
	ana.send(film.Id, "four")
	if rs := readStateFor(bob.state(), film.Id); rs == nil || rs.UnreadCount != 1 {
		t.Fatalf("after a new message: %v, want 1 unread", rs)
	}
}

// A deleted bot leaves its channels, and its open stream ends: it must not
// keep receiving private channel traffic. Rotating the token ends it too.
func TestDeletedBotLosesAccess(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	created := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"})))
	bot := e.client(created.Token)
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	must(ana.chat.AddChannelMembers(ctx(), connect.NewRequest(&v1.AddChannelMembersRequest{ChannelId: secret.Id, MemberIds: []string{created.Bot.Id}})))

	sub := bot.subscribe(0)
	sub.next(func(ev *v1.Event) bool { return ev.GetHeartbeat() }, nil)
	must(ana.bots.DeleteBot(ctx(), connect.NewRequest(&v1.DeleteBotRequest{BotId: created.Bot.Id})))
	ana.send(secret.Id, "after delete")
	timeout := time.After(5 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-sub.events:
			if ev.GetMessageCreated() != nil {
				t.Fatalf("deleted bot got %v", ev)
			}
		case <-sub.done:
			done = true
		case <-timeout:
			t.Fatal("deleted bot's stream is still open")
		}
	}
	for _, ch := range ana.state().Channels {
		if ch.Id == secret.Id && slices.Contains(ch.MemberIds, created.Bot.Id) {
			t.Fatalf("deleted bot is still in #secret: %v", ch.MemberIds)
		}
	}

	other := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "other"})))
	sub = e.client(other.Token).subscribe(0)
	sub.next(func(ev *v1.Event) bool { return ev.GetHeartbeat() }, nil)
	must(ana.bots.RotateBotToken(ctx(), connect.NewRequest(&v1.RotateBotTokenRequest{BotId: other.Bot.Id})))
	select {
	case <-sub.done:
	case <-time.After(5 * time.Second):
		t.Fatal("a rotated token's stream is still open")
	}
}

// Search hides messages the retention setting expired before the prune runs,
// like ListMessages.
func TestSearchHidesExpired(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	ana.send(gen.Id, "ancient words")
	e.clock.Advance(31 * 24 * time.Hour)
	ana = e.client(e.token("ana"))
	ana.send(gen.Id, "fresh words")
	must(ana.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{RetentionDays: new(int32(30))})))
	for _, ch := range []string{"", gen.Id} {
		ms, err := ana.search("words", ch)
		if err != nil || len(ms) != 1 || ms[0].Text != "fresh words" {
			t.Fatalf("search in %q = %v %v, want only the fresh message", ch, ms, err)
		}
	}
}

// In OPT_IN mode a member may preview a text channel they have not joined,
// but posting, reacting and typing there need a join first, as in Slack.
func TestOptInWritesNeedJoin(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	bob := e.join("bob")
	ana.setMode(v1.ChannelMode_CHANNEL_MODE_OPT_IN)
	film := ana.channel("film", v1.ChannelKind_CHANNEL_KIND_TEXT)
	msg := ana.send(film.Id, "hello")

	if _, err := bob.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: film.Id})); err != nil {
		t.Fatalf("preview: %v", err)
	}
	notJoined := func(what string, err error) {
		t.Helper()
		if connect.CodeOf(err) != connect.CodeFailedPrecondition {
			t.Errorf("%s before joining: %v, want failed_precondition", what, err)
		}
	}
	_, err := bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: film.Id, Text: "hi"}))
	notJoined("send", err)
	_, err = bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: film.Id, Text: "hi", ThreadRootId: msg.Id}))
	notJoined("thread reply", err)
	_, err = bob.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: msg.Id, Emoji: "👍"}))
	notJoined("react", err)
	_, err = bob.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: film.Id}))
	notJoined("typing", err)

	if err := bob.joinChannel(film.Id); err != nil {
		t.Fatal(err)
	}
	bob.send(film.Id, "hi")
	must(bob.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: msg.Id, Emoji: "👍"})))
	if err := bob.leaveChannel(film.Id); err != nil {
		t.Fatal(err)
	}
	_, err = bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: film.Id, Text: "bye"}))
	notJoined("send after leaving", err)
}

// An "only admins post" channel (1290): admins post, members get
// permission_denied for a top-level post but may still react and reply in
// threads. Only admins may turn it on, and everyone sees the flag.
func TestAdminsPostOnly(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana") // owner
	bob := e.join("bob")
	news := ana.channel("news", v1.ChannelKind_CHANNEL_KIND_TEXT)
	on := true
	if _, err := bob.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: news.Id, AdminsPostOnly: &on})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member turned it on: %v", err)
	}
	ch := must(ana.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: news.Id, AdminsPostOnly: &on}))).Channel
	if !ch.AdminsPostOnly {
		t.Fatal("flag not set")
	}
	for _, c := range bob.state().Channels {
		if c.Id == news.Id && !c.AdminsPostOnly {
			t.Fatal("members do not see the flag")
		}
	}
	post := ana.send(news.Id, "v2 is out")
	_, err := bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: news.Id, Text: "me too"}))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("member posted: %v", err)
	}
	must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: news.Id, Text: "nice", ThreadRootId: post.Id})))
	must(bob.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: post.Id, Emoji: "👍"})))

	off := false
	must(ana.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: news.Id, AdminsPostOnly: &off})))
	bob.send(news.Id, "now I can")
}
