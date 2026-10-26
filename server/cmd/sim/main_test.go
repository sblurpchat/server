package main

import "testing"

func TestPick(t *testing.T) {
	want := map[int]action{0: post, 49: post, 50: thread, 64: thread, 65: mention, 76: mention, 77: dm, 88: dm, 89: groupDM, 99: groupDM}
	for roll, a := range want {
		if got := pick(roll); got != a {
			t.Errorf("pick(%d) = %s, want %s", roll, got, a)
		}
	}
}
