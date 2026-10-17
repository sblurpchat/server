package server

import (
	"maps"
	"testing"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// 1060: a reconnect burst of more than subBuffer members must not drop a
// subscriber that has not read yet, or each drop feeds more presence.
func TestPresenceBurstDoesNotDrop(t *testing.T) {
	h := newHub(func() int64 { return 0 })
	slow := h.add("slow")
	for i := range subBuffer + 100 {
		other := h.add(string(rune('a'+i%26)) + string(rune(i)))
		if i%2 == 0 {
			h.remove(other) // flapping: online then offline
		}
	}
	select {
	case <-slow.gone:
		t.Fatal("presence burst dropped the subscriber")
	default:
	}
}

func TestPresenceKeepsLatestPerMember(t *testing.T) {
	h := newHub(func() int64 { return 0 })
	ana := h.add("ana")
	bob := h.add("bob")
	h.remove(bob)
	h.add("bob")
	h.add("cat")
	<-ana.wake
	got := map[string]v1.Presence{}
	for id, ev := range h.takePresence(ana) {
		got[id] = ev.GetPresence().Presence
	}
	want := map[string]v1.Presence{"ana": v1.Presence_PRESENCE_ONLINE, "bob": v1.Presence_PRESENCE_ONLINE, "cat": v1.Presence_PRESENCE_ONLINE}
	if !maps.Equal(got, want) {
		t.Fatalf("presence = %v, want %v", got, want)
	}
	if h.takePresence(ana) != nil {
		t.Fatal("takePresence did not clear")
	}
}

func TestPresenceBatch(t *testing.T) {
	if presenceBatch(nil, 5) != nil {
		t.Fatal("empty pending should send nothing")
	}
	on := func(id string) *v1.Event {
		return &v1.Event{AtMs: 1, Kind: &v1.Event_Presence{Presence: &v1.PresenceEvent{MemberId: id, Presence: v1.Presence_PRESENCE_ONLINE}}}
	}
	if ev := presenceBatch(map[string]*v1.Event{"a": on("a")}, 5); ev.GetPresence().GetMemberId() != "a" {
		t.Fatalf("one change = %v, want a plain presence event", ev)
	}
	ev := presenceBatch(map[string]*v1.Event{"a": on("a"), "b": on("b")}, 5)
	got := map[string]bool{}
	for _, p := range ev.GetPresenceBatch().GetChanges() {
		got[p.MemberId] = p.Presence == v1.Presence_PRESENCE_ONLINE
	}
	if !maps.Equal(got, map[string]bool{"a": true, "b": true}) || ev.AtMs != 5 {
		t.Fatalf("batch = %v", ev)
	}
}
