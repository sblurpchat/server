package main

import (
	"testing"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestPick(t *testing.T) {
	want := map[int]action{0: post, 34: post, 35: thread, 54: thread, 55: react, 64: react, 65: image, 74: image, 75: mention, 84: mention, 85: dm, 92: dm, 93: groupDM, 99: groupDM}
	for roll, a := range want {
		if got := pick(roll); got != a {
			t.Errorf("pick(%d) = %s, want %s", roll, got, a)
		}
	}
}

func TestPickRoot(t *testing.T) {
	ms := []*v1.Message{{Id: "a", AuthorId: "me"}, {Id: "b", AuthorId: "me", Deleted: true}, {Id: "c"}, {Id: "d"}, {Id: "e"}}
	for roll, want := range map[int]string{0: "a", 2: "a", 3: "e", 4: "d", 5: "c"} {
		if got := pickRoot(ms, "me", roll); got != want {
			t.Errorf("roll %d = %s, want %s", roll, got, want)
		}
	}
	if got := pickRoot(ms[2:], "me", 0); got != "e" { // none of mine: the newest
		t.Errorf("no own message = %s", got)
	}
	if got := pickRoot(ms[4:], "", 5); got != "e" {
		t.Errorf("one message = %s", got)
	}
	if pickRoot(nil, "me", 0) != "" {
		t.Error("empty channel")
	}
}

func TestBurst(t *testing.T) {
	for roll, want := range map[int]int{0: 1, 91: 1, 92: 3, 93: 4, 94: 5, 95: 6, 99: 6} {
		if got := burst(roll); got != want {
			t.Errorf("burst(%d) = %d, want %d", roll, got, want)
		}
	}
}
