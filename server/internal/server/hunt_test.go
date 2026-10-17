package server

import (
	"testing"

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
