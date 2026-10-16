package seed

import (
	"regexp"
	"testing"
)

var (
	userRe    = regexp.MustCompile(`^[a-z0-9_.-]{2,32}$`)
	channelRe = regexp.MustCompile(`^[a-z0-9_-]{1,80}$`)
	mentionRe = regexp.MustCompile(`@([a-z0-9_.-]+)`)
)

func TestCommunities(t *testing.T) {
	for _, name := range []string{"community", "owls"} {
		t.Run(name, func(t *testing.T) {
			c, ok := Get(name)
			if !ok {
				t.Fatal("missing")
			}
			checkCommunity(t, c)
		})
	}
	if _, ok := Get("nope"); ok {
		t.Error("Get(nope) should be false")
	}
}

func checkCommunity(t *testing.T, c Community) {
	if c.Description == "" || !regexp.MustCompile(`^#[0-9a-f]{6}$`).MatchString(c.Accent) {
		t.Errorf("bad description/accent %q %q", c.Description, c.Accent)
	}
	if n := len(c.Members); n < 8 || n > 15 {
		t.Errorf("member count %d", n)
	}
	known := map[string]bool{}
	for _, m := range append(append([]Member{}, c.Members...), c.Bot) {
		if !userRe.MatchString(m.Username) {
			t.Errorf("bad username %q", m.Username)
		}
		if known[m.Username] {
			t.Errorf("duplicate username %q", m.Username)
		}
		known[m.Username] = true
		if m.Display == "" || len([]rune(m.Display)) > 80 {
			t.Errorf("bad display %q", m.Display)
		}
		switch m.Role {
		case "", "moderator", "admin":
		default:
			t.Errorf("bad role %q", m.Role)
		}
	}

	total := 0
	checkConvos := func(where string, convos []Convo) {
		seen := map[float64]bool{}
		for _, cv := range convos {
			if cv.DaysAgo < 0 || cv.DaysAgo > 14 {
				t.Errorf("%s: DaysAgo %v", where, cv.DaysAgo)
			}
			if seen[cv.DaysAgo] {
				t.Errorf("%s: duplicate DaysAgo %v", where, cv.DaysAgo)
			}
			seen[cv.DaysAgo] = true
			if len(cv.Lines) == 0 {
				t.Errorf("%s: empty convo", where)
			}
			var check func(l Line, reply bool)
			check = func(l Line, reply bool) {
				total++
				if !known[l.By] {
					t.Errorf("%s: unknown author %q", where, l.By)
				}
				if l.Text == "" || len(l.Text) > 8000 {
					t.Errorf("%s: bad text length %d", where, len(l.Text))
				}
				for _, m := range mentionRe.FindAllStringSubmatch(l.Text, -1) {
					if !known[m[1]] {
						t.Errorf("%s: unknown mention @%s in %q", where, m[1], l.Text)
					}
				}
				for emoji, users := range l.React {
					for _, u := range users {
						if !known[u] {
							t.Errorf("%s: unknown reactor %q on %s", where, u, emoji)
						}
					}
				}
				if reply && len(l.Replies) > 0 {
					t.Errorf("%s: nested replies", where)
				}
				for _, r := range l.Replies {
					check(r, true)
				}
			}
			for _, l := range cv.Lines {
				check(l, false)
			}
		}
	}

	chans := map[string]bool{}
	for _, ch := range c.Channels {
		if !channelRe.MatchString(ch.Name) || chans[ch.Name] {
			t.Errorf("bad or duplicate channel %q", ch.Name)
		}
		chans[ch.Name] = true
		if ch.Private != (len(ch.Members) > 0) {
			t.Errorf("#%s: private=%v but %d members", ch.Name, ch.Private, len(ch.Members))
		}
		for _, u := range ch.Members {
			if !known[u] {
				t.Errorf("#%s: unknown member %q", ch.Name, u)
			}
		}
		checkConvos("#"+ch.Name, ch.Convos)
	}
	for i, dm := range c.DMs {
		if len(dm.Members) < 2 {
			t.Errorf("dm %d: %d members", i, len(dm.Members))
		}
		for _, u := range dm.Members {
			if !known[u] {
				t.Errorf("dm %d: unknown member %q", i, u)
			}
		}
		checkConvos("dm", dm.Convos)
	}
	if total < 250 {
		t.Errorf("only %d messages", total)
	}
	t.Logf("%d members, %d channels, %d DMs, %d messages", len(c.Members), len(c.Channels), len(c.DMs), total)
}
