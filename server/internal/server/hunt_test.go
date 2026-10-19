package server

import (
	"database/sql"
	"io/fs"
	"slices"
	"sort"
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

// Who can post (1308): a channel lists the roles that may start top-level
// messages. Admins and the owner always may; "moderator" and custom roles let
// others in. Everyone in the channel still reacts, replies in threads and
// edits their own messages. Only admins change the list, and everyone sees it.
func TestWhoCanPost(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana") // owner
	bob, mo, dee := e.join("bob"), e.join("mo"), e.join("dee")
	must0(t, ana.setRole(mo.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR))
	staff := must(ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "staff"}))).Role
	must0(t, ana.giveRoles(dee.me.Id, staff.Id))
	news := ana.channel("news", v1.ChannelKind_CHANNEL_KIND_TEXT)
	reply := bob.send(news.Id, "before")
	limit := func(c *client, ids ...string) error {
		_, err := c.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: news.Id, PostRoles: &v1.PostRoles{RoleIds: ids}}))
		return err
	}
	post := func(c *client, root string) error {
		_, err := c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: news.Id, Text: "hi", ThreadRootId: root}))
		return err
	}
	for _, c := range []*client{bob, mo} {
		if err := limit(c, "admin"); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("%s changed who can post: %v", c.me.Username, err)
		}
	}
	if err := limit(ana, "nope"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown role: %v", err)
	}

	must0(t, limit(ana, "moderator", "admin", "moderator"))
	for _, c := range bob.state().Channels {
		if c.Id == news.Id && !slices.Equal(c.PostRoleIds, []string{"admin", "moderator"}) {
			t.Fatalf("members see post roles %v", c.PostRoleIds)
		}
	}
	root := ana.send(news.Id, "v2 is out")
	must0(t, post(mo, ""))
	for _, c := range []*client{bob, dee} {
		if err := post(c, ""); connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("%s posted: %v", c.me.Username, err)
		}
	}
	r := must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: news.Id, Text: "nice", ThreadRootId: root.Id}))).Message
	must(bob.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: root.Id, Emoji: "👍"})))
	must(bob.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: r.Id, Text: "very nice"})))
	must(bob.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: reply.Id, Text: "before, edited"})))

	// A custom role lets its members in, and then moderators are out.
	must0(t, limit(ana, staff.Id))
	must0(t, post(dee, ""))
	if err := post(mo, ""); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("moderator posted in an admins-only channel: %v", err)
	}
	must0(t, post(ana, ""))
	// Deleting the only post role leaves the channel to admins, not everyone.
	must(ana.srv.DeleteRole(ctx(), connect.NewRequest(&v1.DeleteRoleRequest{RoleId: staff.Id})))
	if err := post(dee, ""); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("deleted role still posts: %v", err)
	}
	if ch := must(ana.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: news.Id}))).Channel; !slices.Equal(ch.PostRoleIds, []string{"admin"}) {
		t.Fatalf("after delete: %v", ch.PostRoleIds)
	}

	must0(t, limit(ana))
	bob.send(news.Id, "now I can")
}

func must0(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// Migration 016 turns an "only admins post" channel (015) into a post list
// of "admin", and leaves other channels open.
func TestMigratePostRoles(t *testing.T) {
	path := t.TempDir() + "/old.db"
	old, err := sql.Open("sqlite", "file:"+path)
	must0(t, err)
	names, _ := fs.Glob(migrations, "migrations/*.sql")
	sort.Strings(names)
	for _, n := range names[:15] {
		body, _ := migrations.ReadFile(n)
		_, err := old.Exec(string(body))
		must0(t, err)
	}
	_, err = old.Exec(`PRAGMA user_version = 15;
		INSERT INTO channels(id, kind, name, created_at_ms, admins_post_only) VALUES ('a', 1, 'news', 0, 1), ('b', 1, 'chat', 0, 0)`)
	must0(t, err)
	old.Close()
	d, err := openDB(path)
	must0(t, err)
	defer d.close()
	cs, err := queryChannels(ctx(), d.r, "1")
	must0(t, err)
	if len(cs) != 2 || cs[0].Name != "chat" || len(cs[0].PostRoleIds) != 0 || !slices.Equal(cs[1].PostRoleIds, []string{"admin"}) {
		t.Fatalf("after migrate: %v", cs)
	}
}
