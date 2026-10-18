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
