package server

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Activity lists mentions, replies in my threads and reactions to my
// messages, newest first, without hidden members (1405). Threads lists the
// threads I am in with replies I have not seen.
func TestActivityAndThreads(t *testing.T) {
	e := newEnv(t)
	ana, bob, cat := e.join("ana"), e.join("bob"), e.join("cat")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	names := map[string]string{ana.me.Id: "ana", bob.me.Id: "bob", cat.me.Id: "cat"}
	send := func(c *client, text string) *v1.Message {
		e.clock.Advance(time.Millisecond)
		return c.send(gen.Id, text)
	}
	reply := func(c *client, root, text string) *v1.Message {
		e.clock.Advance(time.Millisecond)
		return must(c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: root, Text: text}))).Message
	}
	react := func(c *client, id, emoji string) {
		e.clock.Advance(time.Millisecond)
		must(c.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: id, Emoji: emoji})))
	}
	activity := func(c *client) string {
		var out []string
		for _, it := range must(c.chat.ListActivity(ctx(), connect.NewRequest(&v1.ListActivityRequest{}))).Items {
			out = append(out, fmt.Sprintf("%s %s %s %s", strings.TrimPrefix(it.Kind.String(), "ACTIVITY_KIND_"), names[it.ActorId], it.Message.Text, it.Emoji))
		}
		return strings.Join(out, "\n")
	}
	threads := func(c *client) string {
		var out []string
		for _, t := range must(c.chat.ListThreads(ctx(), connect.NewRequest(&v1.ListThreadsRequest{}))).Threads {
			out = append(out, fmt.Sprintf("%s %d", t.Root.Text, t.UnreadCount))
		}
		return strings.Join(out, "\n")
	}

	mine := send(ana, "ana's root")
	bobs := send(bob, "bob's root")
	send(bob, "hi <@"+ana.me.Id+">")
	send(bob, "not a mention <@"+bob.me.Id+">")
	reply(bob, mine.Id, "bob replies")
	reply(bob, mine.Id, "bob replies <@"+ana.me.Id+">") // a mention, not also a reply
	reply(ana, bobs.Id, "ana joins bob's thread")
	reply(bob, bobs.Id, "bob answers")
	react(bob, mine.Id, "👍")
	react(ana, mine.Id, "🎉")          // my own reaction is not activity
	send(ana, "hey <@"+ana.me.Id+">") // nor my own mention
	send(cat, "cat says <@"+ana.me.Id+">")
	reply(cat, mine.Id, "cat replies")
	must(ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: cat.me.Id})))

	want := strings.Join([]string{
		"REACTION bob ana's root 👍",
		"MENTION bob bob replies <@" + ana.me.Id + "> ",
		"REPLY bob bob replies ",
		"MENTION bob hi <@" + ana.me.Id + "> ",
	}, "\n")
	if got := activity(ana); got != want {
		t.Fatalf("activity:\n%s\nwant:\n%s", got, want)
	}
	if got := activity(cat); got != "" {
		t.Fatalf("cat's activity: %q", got)
	}

	// ana's root: two replies from bob (cat is muted). bob's root: one after ana posted.
	if got, want := threads(ana), "ana's root 2\nbob's root 1"; got != want {
		t.Fatalf("threads:\n%s\nwant:\n%s", got, want)
	}
	must(ana.chat.MarkRead(ctx(), connect.NewRequest(&v1.MarkReadRequest{ThreadRootId: mine.Id})))
	if got, want := threads(ana), "ana's root 0\nbob's root 1"; got != want {
		t.Fatalf("after mark:\n%s\nwant:\n%s", got, want)
	}
	reply(ana, bobs.Id, "ana again")
	reply(bob, mine.Id, "bob more")
	if got, want := threads(ana), "ana's root 1\nbob's root 0"; got != want {
		t.Fatalf("after posts:\n%s\nwant:\n%s", got, want)
	}
	// cat replied once in ana's thread; bob posted once after that.
	if got, want := threads(cat), "ana's root 1"; got != want {
		t.Fatalf("cat's threads: %q", got)
	}

	// Only thread roots in channels I can see.
	_, err := ana.chat.MarkRead(ctx(), connect.NewRequest(&v1.MarkReadRequest{ThreadRootId: "nope"}))
	wantCode(t, err, connect.CodeNotFound)
	priv := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	if err := ana.addTo(priv.Id, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	hidden := bob.send(priv.Id, "hidden <@"+ana.me.Id+">")
	if err := ana.removeFrom(priv.Id, ana.me.Id); err != nil {
		t.Fatal(err)
	}
	_, err = ana.chat.MarkRead(ctx(), connect.NewRequest(&v1.MarkReadRequest{ThreadRootId: hidden.Id}))
	wantCode(t, err, connect.CodeNotFound)
	if strings.Contains(activity(ana), "hidden") {
		t.Fatal("activity leaks a private channel")
	}
}
