package mcp

import (
	"testing"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestMentions(t *testing.T) {
	byName := map[string]string{"alice": "A1", "bob.b": "B2"}
	for in, want := range map[string]string{
		"hi @alice":                  "hi <@A1>",
		"@Alice, look":               "<@A1>, look",
		"thanks @bob.b.":             "thanks <@B2>.",
		"(@alice)":                   "(<@A1>)",
		"mail alice@alice.com":       "mail alice@alice.com",
		"@nobody here":               "@nobody here",
		"@alice and @bob.b- ok":      "<@A1> and <@B2>- ok",
		"already <@A1> wired @alice": "already <@A1> wired <@A1>",
	} {
		if got := toWire(in, byName); got != want {
			t.Errorf("toWire(%q) = %q, want %q", in, got, want)
		}
	}
	n := map[string]string{"A1": "alice"}
	if got := fromWire("hey <@A1> and <@ZZ>", n); got != "hey @alice and <@ZZ>" {
		t.Errorf("fromWire: %q", got)
	}
}

func TestFindChannel(t *testing.T) {
	chs := []*v1.Channel{{Id: "c1", Name: "General"}, {Id: "c2", Name: "random"}, {Id: "d1", Kind: v1.ChannelKind_CHANNEL_KIND_DM}}
	for q, want := range map[string]string{"general": "c1", "#General": "c1", "c2": "c2", "d1": "d1", "nope": "", "": ""} {
		got := ""
		if ch := findChannel(chs, q); ch != nil {
			got = ch.Id
		}
		if got != want {
			t.Errorf("findChannel(%q) = %q, want %q", q, got, want)
		}
	}
}

func TestNegotiate(t *testing.T) {
	for asked, want := range map[string]string{"2025-06-18": "2025-06-18", "2025-11-25": "2025-11-25", "2024-11-05": "2025-11-25", "": "2025-11-25"} {
		if got := negotiate(asked); got != want {
			t.Errorf("negotiate(%q) = %q, want %q", asked, got, want)
		}
	}
}

func TestSchema(t *testing.T) {
	s := schema([]string{"a"}, "a", "string", "A.", "b", "integer", "B.")
	p := s["properties"].(map[string]any)
	if len(p) != 2 || p["b"].(map[string]any)["type"] != "integer" || s["required"].([]string)[0] != "a" {
		t.Fatalf("schema: %v", s)
	}
	if _, ok := schema(nil)["required"]; ok {
		t.Fatal("empty required list should be left out")
	}
}
