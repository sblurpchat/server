package mcp

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

type tool struct {
	name, desc string
	schema     map[string]any
	readOnly   bool
	run        func(context.Context, *call) (string, error)
}

func schema(required []string, props ...string) map[string]any {
	p := map[string]any{}
	for i := 0; i+2 < len(props); i += 3 {
		p[props[i]] = map[string]any{"type": props[i+1], "description": props[i+2]}
	}
	s := map[string]any{"type": "object", "properties": p}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

const (
	chanArg  = "A channel name like general or #general, or a channel id from list_channels."
	limitArg = "How many to return (default %d, max %d)."
)

var tools = []tool{
	{"list_channels", "List the channels and direct messages you are in, with ids, topics and unread counts.",
		schema(nil), true, listChannels},
	{"read_messages", "Read recent messages in a channel, oldest first, or the replies in one thread.",
		schema([]string{"channel"},
			"channel", "string", chanArg,
			"thread", "string", "Optional: the id of a thread's first message, to read its replies.",
			"before", "string", "Optional: a message id; returns the messages before it (for paging back).",
			"limit", "integer", fmt.Sprintf(limitArg, 30, 100)), true, readMessages},
	{"search_messages", "Full-text search over messages in your channels, newest first.",
		schema([]string{"query"},
			"query", "string", "Words to search for.",
			"channel", "string", "Optional: search only this channel. "+chanArg,
			"limit", "integer", fmt.Sprintf(limitArg, 20, 100)), true, searchMessages},
	{"post_message", "Post a message in a channel as the signed-in person, or reply in a thread. Write @username to mention someone.",
		schema([]string{"channel", "text"},
			"channel", "string", chanArg,
			"text", "string", "The message. Markdown: **bold**, *italic*, `code`, links.",
			"thread", "string", "Optional: the id of a message to reply to in its thread."), false, postMessage},
	{"send_direct_message", "Send a direct message to one member as the signed-in person.",
		schema([]string{"username", "text"},
			"username", "string", "The member's username, with or without @.",
			"text", "string", "The message."), false, sendDM},
	{"list_members", "List the community's members: username, display name, role and presence.",
		schema(nil, "query", "string", "Optional: only members whose username or display name contains this."), true, listMembers},
}

// call is one tool call: the caller's token and the arguments.
type call struct {
	h     *Handler
	auth  string
	args  map[string]any
	state *v1.GetStateResponse
}

func (c *call) str(k string) string {
	s, _ := c.args[k].(string)
	return strings.TrimSpace(s)
}

func (c *call) need(k string) (string, error) {
	if s := c.str(k); s != "" {
		return s, nil
	}
	return "", fmt.Errorf("%s is required", k)
}

func (c *call) limit(def, max int) int32 {
	n, _ := c.args["limit"].(float64) // JSON numbers
	if n < 1 {
		return int32(def)
	}
	return int32(min(int(n), max))
}

func (c *call) getState(ctx context.Context) (*v1.GetStateResponse, error) {
	if c.state == nil {
		res, err := c.h.srv.GetState(ctx, withAuth(c.auth, &v1.GetStateRequest{}))
		if err != nil {
			return nil, err
		}
		c.state = res.Msg
	}
	return c.state, nil
}

// names maps member ids to usernames.
func names(st *v1.GetStateResponse) map[string]string {
	m := map[string]string{}
	for _, x := range st.Members {
		m[x.Id] = x.Username
	}
	return m
}

func (c *call) channel(ctx context.Context, q string) (*v1.Channel, *v1.GetStateResponse, error) {
	st, err := c.getState(ctx)
	if err != nil {
		return nil, nil, err
	}
	ch := findChannel(st.Channels, q)
	if ch == nil {
		return nil, nil, fmt.Errorf("you are not in a channel called %q; call list_channels to see yours", q)
	}
	return ch, st, nil
}

// findChannel matches a channel by id, or by name with or without "#",
// ignoring case.
func findChannel(chs []*v1.Channel, q string) *v1.Channel {
	name := strings.ToLower(strings.TrimPrefix(q, "#"))
	for _, ch := range chs {
		if ch.Id == q || (ch.Name != "" && strings.ToLower(ch.Name) == name) {
			return ch
		}
	}
	return nil
}

func label(ch *v1.Channel, st *v1.GetStateResponse, n map[string]string) string {
	if ch.Kind != v1.ChannelKind_CHANNEL_KIND_DM {
		return "#" + ch.Name
	}
	var who []string
	for _, id := range ch.MemberIds {
		if id != st.GetMe().GetId() {
			who = append(who, "@"+n[id])
		}
	}
	return "DM with " + strings.Join(who, ", ")
}

var wireMention = regexp.MustCompile(`<@([^>\s]+)>`)

// fromWire turns <@member_id> mentions into @username.
func fromWire(text string, n map[string]string) string {
	return wireMention.ReplaceAllStringFunc(text, func(m string) string {
		if u, ok := n[m[2:len(m)-1]]; ok {
			return "@" + u
		}
		return m
	})
}

var plainMention = regexp.MustCompile(`(^|[\s(\[{,;:!?"'])@([A-Za-z0-9_.-]+)`)

// toWire turns @username into <@member_id> for members that exist. byName
// maps lowercase usernames to ids. Trailing dots and dashes are punctuation.
func toWire(text string, byName map[string]string) string {
	return plainMention.ReplaceAllStringFunc(text, func(m string) string {
		at := strings.IndexByte(m, '@')
		name := m[at+1:]
		trimmed := strings.TrimRight(name, ".-")
		if id, ok := byName[strings.ToLower(trimmed)]; ok {
			return m[:at] + "<@" + id + ">" + name[len(trimmed):]
		}
		return m
	})
}

func formatMessage(m *v1.Message, n map[string]string) string {
	who := n[m.AuthorId]
	if who == "" {
		who = "unknown"
	}
	text := fromWire(m.Text, n)
	if m.Deleted {
		text = "(deleted)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[%s] @%s (id %s): %s", time.UnixMilli(m.CreatedAtMs).UTC().Format("2006-01-02 15:04 UTC"), who, m.Id,
		strings.ReplaceAll(text, "\n", "\n    "))
	for _, a := range m.Attachments {
		fmt.Fprintf(&b, " [attachment: %s]", a.Name)
	}
	if m.ReplyCount > 0 {
		fmt.Fprintf(&b, " [%d replies in thread]", m.ReplyCount)
	}
	return b.String()
}

func listChannels(ctx context.Context, c *call) (string, error) {
	st, err := c.getState(ctx)
	if err != nil {
		return "", err
	}
	unread := map[string]int32{}
	for _, rs := range st.ReadStates {
		unread[rs.ChannelId] = rs.UnreadCount
	}
	n := names(st)
	var b strings.Builder
	fmt.Fprintf(&b, "You are @%s.\n", st.GetMe().GetUsername())
	for _, ch := range st.Channels {
		fmt.Fprintf(&b, "%s (id %s)", label(ch, st, n), ch.Id)
		if ch.Kind == v1.ChannelKind_CHANNEL_KIND_PRIVATE {
			b.WriteString(" private")
		}
		if u := unread[ch.Id]; u > 0 {
			fmt.Fprintf(&b, " %d unread", u)
		}
		if ch.Topic != "" {
			b.WriteString(": " + ch.Topic)
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}

func readMessages(ctx context.Context, c *call) (string, error) {
	q, err := c.need("channel")
	if err != nil {
		return "", err
	}
	ch, st, err := c.channel(ctx, q)
	if err != nil {
		return "", err
	}
	res, err := c.h.chat.ListMessages(ctx, withAuth(c.auth, &v1.ListMessagesRequest{
		ChannelId: ch.Id, ThreadRootId: c.str("thread"), BeforeId: c.str("before"), Limit: c.limit(30, 100)}))
	if err != nil {
		return "", err
	}
	n := names(st)
	var b strings.Builder
	where := label(ch, st, n)
	if c.str("thread") != "" {
		where = "the thread " + c.str("thread") + " in " + where
	}
	fmt.Fprintf(&b, "Messages in %s, oldest first:\n", where)
	for _, m := range res.Msg.Messages {
		b.WriteString(formatMessage(m, n) + "\n")
	}
	if len(res.Msg.Messages) == 0 {
		b.WriteString("(none)\n")
	} else if res.Msg.HasMore {
		fmt.Fprintf(&b, "Older messages exist: pass before=%s to read them.\n", res.Msg.Messages[0].Id)
	}
	return b.String(), nil
}

func searchMessages(ctx context.Context, c *call) (string, error) {
	q, err := c.need("query")
	if err != nil {
		return "", err
	}
	st, err := c.getState(ctx)
	if err != nil {
		return "", err
	}
	req := &v1.SearchRequest{Query: q, Limit: c.limit(20, 100)}
	if c.str("channel") != "" {
		ch, _, err := c.channel(ctx, c.str("channel"))
		if err != nil {
			return "", err
		}
		req.ChannelId = ch.Id
	}
	res, err := c.h.chat.Search(ctx, withAuth(c.auth, req))
	if err != nil {
		return "", err
	}
	n := names(st)
	if len(res.Msg.Messages) == 0 {
		return "No messages match.", nil
	}
	var b strings.Builder
	for _, m := range res.Msg.Messages {
		where := m.ChannelId
		if ch := findChannel(st.Channels, m.ChannelId); ch != nil {
			where = label(ch, st, n)
		}
		if m.ThreadRootId != "" {
			where += ", thread " + m.ThreadRootId
		}
		b.WriteString("in " + where + ": " + formatMessage(m, n) + "\n")
	}
	return b.String(), nil
}

func (c *call) send(ctx context.Context, st *v1.GetStateResponse, ch *v1.Channel, text, thread string) (string, error) {
	byName := map[string]string{}
	for _, m := range st.Members {
		byName[strings.ToLower(m.Username)] = m.Id
	}
	res, err := c.h.chat.SendMessage(ctx, withAuth(c.auth, &v1.SendMessageRequest{ChannelId: ch.Id, Text: toWire(text, byName), ThreadRootId: thread}))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Posted in %s (message id %s).", label(ch, st, names(st)), res.Msg.Message.Id), nil
}

func postMessage(ctx context.Context, c *call) (string, error) {
	q, err := c.need("channel")
	if err != nil {
		return "", err
	}
	text, err := c.need("text")
	if err != nil {
		return "", err
	}
	ch, st, err := c.channel(ctx, q)
	if err != nil {
		return "", err
	}
	return c.send(ctx, st, ch, text, c.str("thread"))
}

func sendDM(ctx context.Context, c *call) (string, error) {
	u, err := c.need("username")
	if err != nil {
		return "", err
	}
	text, err := c.need("text")
	if err != nil {
		return "", err
	}
	st, err := c.getState(ctx)
	if err != nil {
		return "", err
	}
	u = strings.ToLower(strings.TrimPrefix(u, "@"))
	var to string
	for _, m := range st.Members {
		if strings.ToLower(m.Username) == u {
			to = m.Id
		}
	}
	if to == "" {
		return "", errors.New("no member is called @" + u + "; call list_members")
	}
	res, err := c.h.chat.OpenDM(ctx, withAuth(c.auth, &v1.OpenDMRequest{MemberIds: []string{to}}))
	if err != nil {
		return "", err
	}
	return c.send(ctx, st, res.Msg.Channel, text, "")
}

func listMembers(ctx context.Context, c *call) (string, error) {
	st, err := c.getState(ctx)
	if err != nil {
		return "", err
	}
	q := strings.ToLower(strings.TrimPrefix(c.str("query"), "@"))
	var b strings.Builder
	shown := 0
	for _, m := range st.Members {
		if q != "" && !strings.Contains(strings.ToLower(m.Username), q) && !strings.Contains(strings.ToLower(m.DisplayName), q) {
			continue
		}
		if shown++; shown > 200 {
			b.WriteString("More members match; narrow it with query.\n")
			break
		}
		role := strings.ToLower(strings.TrimPrefix(m.Role.String(), "MEMBER_ROLE_"))
		if m.Kind == v1.MemberKind_MEMBER_KIND_BOT {
			role = "bot"
		}
		fmt.Fprintf(&b, "@%s (%s) %s, %s\n", m.Username, m.DisplayName, role, strings.ToLower(strings.TrimPrefix(m.Presence.String(), "PRESENCE_")))
	}
	if shown == 0 {
		return "No members match.", nil
	}
	return b.String(), nil
}
