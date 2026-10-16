package main

import (
	"testing"
	"time"
)

func TestReply(t *testing.T) {
	seven := func(int) int { return 6 } // every die shows 7
	at := time.Date(2026, 10, 16, 21, 5, 0, 0, time.UTC)
	for in, want := range map[string]string{
		"<@b1> roll d20":    "🎲 rolled d20: **7**",
		"<@b1> ROLL 2d8":    "🎲 rolled 2d8: 7 + 7 = **14**",
		"<@b1> roll":        "🎲 rolled d20: **7**",
		"<@b1> roll banana": "I roll dice like `d20` or `2d6`.",
		"<@b1> roll 99d6":   "Up to 20 dice with 2 to 1000 sides, please.",
		"<@b1> time":        "🕰️ It is 21:05 UTC, Friday 16 October.",
		"hey <@b1>":         "Hi! I answer `help`, `roll d20` (or `2d6`), and `time`. Mention me with one of those.",
	} {
		if got := reply(in, at, seven); got != want {
			t.Errorf("reply(%q) = %q, want %q", in, got, want)
		}
	}
}
