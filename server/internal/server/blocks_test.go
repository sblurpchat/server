package server

import (
	"testing"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestDMBlockedAndCanRemoveFrom(t *testing.T) {
	blocks := [][2]string{{"ana", "bob"}, {"cat", "ana"}}
	for _, c := range []struct {
		me     string
		others []string
		want   bool
	}{
		{"ana", []string{"ana", "bob"}, true},  // ana blocked bob
		{"ana", []string{"cat"}, true},         // cat blocked ana
		{"ana", []string{"ana", "dan"}, false}, // nobody involved
		{"ana", nil, false},
	} {
		if got := dmBlocked(c.me, c.others, blocks); got != c.want {
			t.Errorf("dmBlocked(%s, %v) = %v", c.me, c.others, got)
		}
	}
	dm, priv, text := v1.ChannelKind_CHANNEL_KIND_DM, v1.ChannelKind_CHANNEL_KIND_PRIVATE, v1.ChannelKind_CHANNEL_KIND_TEXT
	if !canRemoveFrom(dm, true) || canRemoveFrom(dm, false) || !canRemoveFrom(priv, false) || canRemoveFrom(text, true) {
		t.Fatal("canRemoveFrom")
	}
}

func TestBlockAndLeaveDM(t *testing.T) {
	e := newEnv(t)
	ana, bob, cat := e.join("ana"), e.join("bob"), e.join("cat")
	open := func(c *client, ids ...string) (*v1.Channel, error) {
		res, err := c.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: ids}))
		if err != nil {
			return nil, err
		}
		return res.Msg.Channel, nil
	}
	sendErr := func(c *client, ch string) error {
		_, err := c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: ch, Text: "hi"}))
		return err
	}
	dm := must2(open(bob, ana.me.Id))
	group := must2(open(bob, ana.me.Id, cat.me.Id))

	anaSub := ana.subscribe(ana.state().Seq)
	_, err := ana.srv.BlockMember(ctx(), connect.NewRequest(&v1.BlockMemberRequest{MemberId: ana.me.Id}))
	wantCode(t, err, connect.CodeInvalidArgument)
	_, err = ana.srv.BlockMember(ctx(), connect.NewRequest(&v1.BlockMemberRequest{MemberId: "nobody"}))
	wantCode(t, err, connect.CodeNotFound)
	for range 2 { // twice is fine
		must(ana.srv.BlockMember(ctx(), connect.NewRequest(&v1.BlockMemberRequest{MemberId: bob.me.Id})))
	}
	anaSub.next(func(ev *v1.Event) bool { return ev.GetMemberBlocked() == bob.me.Id }, nil)
	if got := ana.state().BlockedMemberIds; len(got) != 1 || got[0] != bob.me.Id {
		t.Fatalf("blocked = %v", got)
	}
	if got := bob.state().BlockedMemberIds; len(got) != 0 {
		t.Fatalf("bob's blocked = %v", got)
	}

	// Both ways: the blocked one and the blocker.
	_, err = open(bob, ana.me.Id)
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = open(ana, bob.me.Id)
	wantCode(t, err, connect.CodePermissionDenied)
	wantCode(t, sendErr(bob, dm.Id), connect.CodePermissionDenied)
	wantCode(t, sendErr(ana, dm.Id), connect.CodePermissionDenied)
	wantCode(t, sendErr(bob, group.Id), connect.CodePermissionDenied)
	// Others are unaffected.
	cat.send(group.Id, "cat is fine")
	must2(open(cat, bob.me.Id))

	must(ana.srv.UnblockMember(ctx(), connect.NewRequest(&v1.UnblockMemberRequest{MemberId: bob.me.Id})))
	anaSub.next(func(ev *v1.Event) bool { return ev.GetMemberUnblocked() == bob.me.Id }, nil)
	bob.send(dm.Id, "hello again")

	// Leaving a DM hides it; someone else can't be removed from a DM.
	_, err = bob.chat.RemoveChannelMember(ctx(), connect.NewRequest(&v1.RemoveChannelMemberRequest{ChannelId: dm.Id, MemberId: ana.me.Id}))
	wantCode(t, err, connect.CodeInvalidArgument)
	must(ana.chat.RemoveChannelMember(ctx(), connect.NewRequest(&v1.RemoveChannelMemberRequest{ChannelId: dm.Id, MemberId: ana.me.Id})))
	anaSub.next(func(ev *v1.Event) bool { return ev.GetChannelDeleted() == dm.Id }, nil)
	if ana.inState(dm.Id) {
		t.Fatal("left DM still in ana's state")
	}
	// A new message from bob brings it back for ana, history included.
	bob.send(dm.Id, "you there?")
	anaSub.next(func(ev *v1.Event) bool { return ev.GetChannelUpdated().GetId() == dm.Id }, nil)
	anaSub.next(isCreated("you there?"), nil)
	if !ana.inState(dm.Id) {
		t.Fatal("DM did not come back")
	}
	// So does OpenDM by the one who left.
	must(ana.chat.RemoveChannelMember(ctx(), connect.NewRequest(&v1.RemoveChannelMemberRequest{ChannelId: dm.Id, MemberId: ana.me.Id})))
	back := must2(open(ana, bob.me.Id))
	if back.Id != dm.Id || len(back.MemberIds) != 2 {
		t.Fatalf("reopened = %v", back)
	}
	msgs := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: dm.Id}))).Messages
	if len(msgs) != 2 {
		t.Fatalf("history = %d messages", len(msgs))
	}
}

// A muted or blocked member's messages never count toward the reader's
// unread or mention counts (1244, 1293), a mute leaves DMs open, and only the
// muter sees the mute.
func TestMuteSkipsUnreadAndIsPrivate(t *testing.T) {
	e := newEnv(t)
	ana, bob, cat := e.join("ana"), e.join("bob"), e.join("cat")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	dm := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{ana.me.Id}}))).Channel
	bobSub := bob.subscribe(bob.state().Seq)
	anaSub := ana.subscribe(ana.state().Seq)

	_, err := ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: ana.me.Id}))
	wantCode(t, err, connect.CodeInvalidArgument)
	_, err = ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: "nobody"}))
	wantCode(t, err, connect.CodeNotFound)
	for range 2 { // twice is fine
		must(ana.srv.MuteMember(ctx(), connect.NewRequest(&v1.MuteMemberRequest{MemberId: bob.me.Id})))
	}
	must(ana.srv.BlockMember(ctx(), connect.NewRequest(&v1.BlockMemberRequest{MemberId: cat.me.Id})))
	anaSub.next(func(ev *v1.Event) bool { return ev.GetMemberMuted() == bob.me.Id }, nil)
	st := ana.state()
	if len(st.MutedMemberIds) != 1 || st.MutedMemberIds[0] != bob.me.Id {
		t.Fatalf("muted = %v", st.MutedMemberIds)
	}

	// A mute does not stop DMs, unlike a block.
	bob.send(dm.Id, "still a DM")
	bob.send(gen.Id, "hey <@"+ana.me.Id+">")
	bob.send(gen.Id, "plain")
	cat.send(gen.Id, "blocked <@"+ana.me.Id+">")
	if rs := readStateFor(ana.state(), gen.Id); rs.UnreadCount != 0 || rs.MentionCount != 0 {
		t.Fatalf("muted/blocked counted: %v", rs)
	}
	if rs := readStateFor(ana.state(), dm.Id); rs.UnreadCount != 0 || rs.MentionCount != 0 {
		t.Fatalf("muted DM counted: %v", rs)
	}
	// Others still count bob, and bob never learns he is muted.
	if rs := readStateFor(cat.state(), gen.Id); rs.UnreadCount != 2 || rs.MentionCount != 0 {
		t.Fatalf("cat read state = %v", rs)
	}
	if got := bob.state().MutedMemberIds; len(got) != 0 {
		t.Fatalf("bob sees mutes %v", got)
	}

	must(ana.srv.UnmuteMember(ctx(), connect.NewRequest(&v1.UnmuteMemberRequest{MemberId: bob.me.Id})))
	anaSub.next(func(ev *v1.Event) bool { return ev.GetMemberUnmuted() == bob.me.Id }, nil)
	if rs := readStateFor(ana.state(), gen.Id); rs.UnreadCount != 2 || rs.MentionCount != 1 {
		t.Fatalf("after unmute = %v", rs)
	}
	var seen []*v1.Event
	bob.send(gen.Id, "marker")
	bobSub.next(isCreated("marker"), &seen)
	for _, ev := range seen {
		if ev.GetMemberMuted() != "" || ev.GetMemberUnmuted() != "" {
			t.Fatalf("bob got %v", ev)
		}
	}
}

// A DM with only yourself works like Slack's notes-to-self (1309): it opens,
// reopens as the same channel, takes messages, never counts as unread or a
// mention, and can be closed and brought back.
func TestSelfDM(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	open := func(ids ...string) *v1.Channel {
		return must(ana.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: ids}))).Channel
	}
	self := open()
	if self.Kind != v1.ChannelKind_CHANNEL_KIND_DM || len(self.MemberIds) != 1 || self.MemberIds[0] != ana.me.Id {
		t.Fatalf("self DM = %v", self)
	}
	if again := open(ana.me.Id); again.Id != self.Id {
		t.Fatal("reopening must return the same DM")
	}
	if open(bob.me.Id).Id == self.Id {
		t.Fatal("a DM with bob is not the self DM")
	}
	sub := ana.subscribe(ana.state().Seq)
	ana.send(self.Id, "note to self <@"+ana.me.Id+">")
	sub.next(isCreated("note to self <@"+ana.me.Id+">"), nil)
	if rs := readStateFor(ana.state(), self.Id); rs.UnreadCount != 0 || rs.MentionCount != 0 {
		t.Fatalf("self DM counted: %v", rs)
	}
	if bob.inState(self.Id) {
		t.Fatal("bob sees ana's self DM")
	}

	// Close hides it; opening again brings it back with its history.
	must(ana.chat.RemoveChannelMember(ctx(), connect.NewRequest(&v1.RemoveChannelMemberRequest{ChannelId: self.Id, MemberId: ana.me.Id})))
	if ana.inState(self.Id) {
		t.Fatal("closed self DM still in state")
	}
	if back := open(); back.Id != self.Id || len(back.MemberIds) != 1 {
		t.Fatalf("reopened = %v", back)
	}
	if msgs := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: self.Id}))).Messages; len(msgs) != 1 {
		t.Fatalf("history = %d messages", len(msgs))
	}
	if rs := readStateFor(ana.state(), self.Id); rs.UnreadCount != 0 || rs.MentionCount != 0 {
		t.Fatalf("reopened self DM counted: %v", rs)
	}
}

func TestNotifyLevels(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	dm := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{ana.me.Id}}))).Channel
	bob.send(gen.Id, "hey <@"+ana.me.Id+">")
	bob.send(gen.Id, "plain")
	bob.send(dm.Id, "dm")
	level := func(ch string, l v1.NotifyLevel) error {
		_, err := ana.srv.SetNotifyLevel(ctx(), connect.NewRequest(&v1.SetNotifyLevelRequest{ChannelId: ch, Level: l}))
		return err
	}
	ok := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	counts := func(ch string, unread, mentions int32) {
		t.Helper()
		if rs := readStateFor(ana.state(), ch); rs.UnreadCount != unread || rs.MentionCount != mentions {
			t.Fatalf("%s: %v, want %d/%d", ch, rs, unread, mentions)
		}
	}
	wantCode(t, level("nope", v1.NotifyLevel_NOTIFY_LEVEL_ALL), connect.CodeNotFound)
	wantCode(t, level("", 9), connect.CodeInvalidArgument)

	counts(gen.Id, 2, 1)
	sub := ana.subscribe(ana.state().Seq)
	ok(level("", v1.NotifyLevel_NOTIFY_LEVEL_MENTIONS))
	sub.next(func(ev *v1.Event) bool { return ev.GetNotifyLevel().GetLevel() == v1.NotifyLevel_NOTIFY_LEVEL_MENTIONS }, nil)
	sub.next(func(ev *v1.Event) bool { rs := ev.GetReadState(); return rs != nil && rs.ChannelId == gen.Id && rs.UnreadCount == 0 }, nil)
	counts(gen.Id, 0, 1)
	counts(dm.Id, 1, 1) // DMs skip the community level
	ok(level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_NOTHING))
	counts(gen.Id, 0, 0)
	ok(level(dm.Id, v1.NotifyLevel_NOTIFY_LEVEL_NOTHING))
	counts(dm.Id, 0, 0)
	st := ana.state()
	if len(st.NotifyLevels) != 3 {
		t.Fatalf("levels = %v", st.NotifyLevels)
	}
	if len(bob.state().NotifyLevels) != 0 {
		t.Fatal("bob sees ana's levels")
	}
	ok(level(gen.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED))
	ok(level("", v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED))
	counts(gen.Id, 2, 1)

	// A community set to NOTHING quiets DMs too, unless the DM has its own level (1515).
	ok(level(dm.Id, v1.NotifyLevel_NOTIFY_LEVEL_UNSPECIFIED))
	counts(dm.Id, 1, 1)
	sub = ana.subscribe(ana.state().Seq)
	ok(level("", v1.NotifyLevel_NOTIFY_LEVEL_NOTHING))
	sub.next(func(ev *v1.Event) bool { rs := ev.GetReadState(); return rs != nil && rs.ChannelId == dm.Id && rs.UnreadCount == 0 }, nil)
	counts(dm.Id, 0, 0)
	ok(level(dm.Id, v1.NotifyLevel_NOTIFY_LEVEL_ALL))
	counts(dm.Id, 1, 1)
}
