// Package seed holds demo content for a fresh community server. It is plain
// data; the server package turns it into members, channels and messages.
package seed

import "embed"

// Each seeded member and bot has avatars/<username>.webp (credits in
// avatars/CREDITS.txt).
//
//go:embed avatars/*.webp
var avatars embed.FS

// Avatar returns the seeded picture (WebP, 256x256) for username, or nil.
func Avatar(username string) []byte {
	b, _ := avatars.ReadFile("avatars/" + username + ".webp")
	return b
}

// Community is everything one demo server starts with.
type Community struct {
	Description string
	Accent      string // "#rrggbb" for the rail icon
	Members     []Member
	Bot         Member // the server's bot; Role is ignored
	OptIn       bool   // OPT_IN channel mode; ROLES when false
	Roles       []Role // custom roles that gate channels
	Channels    []Channel
	DMs         []DM
}

type Role struct {
	Name    string
	Color   string   // "#rrggbb" or ""
	Members []string // usernames
}

type Member struct {
	Username string // [a-z0-9_.-]{2,32}
	Display  string
	Bio      string
	Emoji    string // status emoji, may be empty
	Status   string // status text, may be empty
	Role     string // "", "moderator" or "admin"
}

type Channel struct {
	Name     string // [a-z0-9_-]{1,80}
	Topic    string
	Category string
	Private  bool
	Members  []string // usernames; private channels only
	Default  bool     // OPT_IN: joined automatically on join
	Roles    []string // role names that may see it; empty is everyone
	Convos   []Convo
}

type DM struct {
	Members []string // usernames, 2 or more
	Convos  []Convo
}

// Convo is a burst of conversation. Lines are a few minutes apart.
type Convo struct {
	DaysAgo float64 // start time, 0 to 14 days before now
	Lines   []Line
}

type Line struct {
	By      string              // username (member or bot)
	Text    string              // "@username" becomes a mention
	React   map[string][]string // emoji -> usernames who reacted
	Replies []Line              // thread replies (one level only)
}

// Get returns the named demo community, or false.
func Get(name string) (Community, bool) {
	switch name {
	case "community":
		return community, true
	case "owls":
		return owls, true
	}
	return Community{}, false
}
