// Command sim is a dev-only chat simulator (ticket 1372). Every few seconds a
// seeded demo person posts in a local dev community. Now and then they
// mention you, DM you, write in a group DM with you, or reply in a thread, so
// every unread, mention and badge state shows up in the client.
//
// It posts over the normal API with the tokens a server started with -seed
// writes to <data>/sim-tokens.json. It is not part of any release build.
//
//	make sim                      # from the repo root
//	go run ./cmd/sim -me statico  # from server/
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"maps"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

type action string

const (
	post    action = "post"
	mention action = "mention"
	thread  action = "thread"
	dm      action = "dm"
	groupDM action = "group-dm"
)

// pick maps a roll in [0, 100) to an action: mostly plain posts, the rest
// split between the states worth seeing.
func pick(roll int) action {
	switch {
	case roll < 50:
		return post
	case roll < 65:
		return thread
	case roll < 77:
		return mention
	case roll < 89:
		return dm
	default:
		return groupDM
	}
}

var lines = []string{
	"Anyone else seeing the deploy queue back up this morning?",
	"Just pushed the fix, give it a minute to roll out.",
	"Coffee count today: three. Send help.",
	"That's a really good point, I hadn't thought about it that way.",
	"Lunch plans? I'm thinking noodles.",
	"Can someone review my PR when they get a chance?",
	"The new build feels so much faster on my phone.",
	"Reminder: demo is at 3 today.",
	"lol same",
	"Found the bug. It was a timezone. It is always a timezone.",
	"I'll write it up in the doc after this meeting.",
	"Has anyone tried the new keyboard shortcuts yet?",
	"Back in 10, grabbing a snack.",
	"Nice work on that release, everyone 🎉",
	"Rain all week here. Perfect coding weather.",
}

var asks = []string{
	"can you take a look at this when you have a sec?",
	"what do you think?",
	"are you around for a quick call later?",
	"I think this one is for you.",
	"did you see the latest numbers?",
}

func main() {
	me := flag.String("me", "statico", "username to mention and DM")
	every := flag.Duration("every", 5*time.Second, "average time between messages")
	dirs := flag.String("communities", "http://localhost:8082=../.data/community,http://localhost:8083=../.data/owls",
		"comma-separated base_url=data_dir pairs; the data dir holds sim-tokens.json")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var comms [][2]string
	for _, p := range strings.Split(*dirs, ",") {
		url, dir, _ := strings.Cut(p, "=")
		comms = append(comms, [2]string{url, dir})
	}
	slog.Info("simulating", "me", *me, "every", *every, "communities", len(comms))
	for ctx.Err() == nil {
		c := comms[rand.IntN(len(comms))]
		if err := step(ctx, c[0], c[1], *me, pick(rand.IntN(100))); err != nil {
			slog.Warn("step", "url", c[0], "err", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(*every/2 + rand.N(*every)): // jitter around every
		}
	}
}

// step posts one message as a random seeded person.
func step(ctx context.Context, url, dir, meName string, act action) error {
	b, err := os.ReadFile(filepath.Join(dir, "sim-tokens.json")) // reread: tokens rotate when the server restarts
	if err != nil {
		return fmt.Errorf("%w (start the server with -seed)", err)
	}
	var toks map[string]string
	if err := json.Unmarshal(b, &toks); err != nil || len(toks) == 0 {
		return fmt.Errorf("no tokens in %s", dir)
	}
	names := slices.Sorted(maps.Keys(toks))
	author := names[rand.IntN(len(names))]
	hc := &http.Client{Transport: bearer(toks[author])}
	srv := sblurpv1connect.NewServerServiceClient(hc, url)
	chat := sblurpv1connect.NewChatServiceClient(hc, url)
	st, err := srv.GetState(ctx, connect.NewRequest(&v1.GetStateRequest{}))
	if err != nil {
		return fmt.Errorf("%s: %w", author, err)
	}
	var meID string
	var others []string // seeded people besides the author, for group DMs
	for _, m := range st.Msg.Members {
		if m.Username == meName {
			meID = m.Id
		} else if m.Id != st.Msg.Me.Id && toks[m.Username] != "" {
			others = append(others, m.Id)
		}
	}
	if meID == "" && act != thread {
		act = post // you have not joined this community
	}
	req := &v1.SendMessageRequest{Text: lines[rand.IntN(len(lines))]}
	switch act {
	case dm, groupDM:
		ids := []string{meID}
		if act == groupDM && len(others) > 0 {
			ids = append(ids, others[rand.IntN(len(others))])
		}
		ch, err := chat.OpenDM(ctx, connect.NewRequest(&v1.OpenDMRequest{MemberIds: ids}))
		if err != nil {
			return fmt.Errorf("open dm: %w", err)
		}
		req.ChannelId = ch.Msg.Channel.Id
	default:
		var chans []*v1.Channel
		for _, ch := range st.Msg.Channels {
			if ch.Kind == v1.ChannelKind_CHANNEL_KIND_TEXT && len(ch.PostRoleIds) == 0 {
				chans = append(chans, ch)
			}
		}
		if len(chans) == 0 {
			return fmt.Errorf("%s is in no open text channel", author)
		}
		req.ChannelId = chans[rand.IntN(len(chans))].Id
		if act == mention {
			req.Text = "<@" + meID + "> " + asks[rand.IntN(len(asks))]
		}
		if act == thread {
			msgs, err := chat.ListMessages(ctx, connect.NewRequest(&v1.ListMessagesRequest{ChannelId: req.ChannelId, Limit: 20}))
			if err != nil {
				return err
			}
			if ms := msgs.Msg.Messages; len(ms) > 0 {
				req.ThreadRootId = ms[rand.IntN(len(ms))].Id
			}
		}
	}
	if _, err := chat.SendMessage(ctx, connect.NewRequest(req)); err != nil {
		return fmt.Errorf("%s %s: %w", author, act, err)
	}
	slog.Info("sent", "url", url, "by", author, "action", act, "thread", req.ThreadRootId != "")
	return nil
}

type bearer string

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}
