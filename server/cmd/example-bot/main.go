// Command example-bot is a small Sblurp bot. A bot is just a member with a
// bot token: it uses the same Connect API as the web client. It subscribes
// to events and answers when mentioned:
//
//	@Slurpy help
//	@Slurpy roll d20      (also 2d6, d100)
//	@Slurpy time
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

func main() {
	url := flag.String("url", "http://localhost:8082", "community server base URL")
	tokenFile := flag.String("token-file", "../.data/community/bot-token.txt", "file holding the bot token (or set SBLURP_BOT_TOKEN)")
	flag.Parse()
	token := os.Getenv("SBLURP_BOT_TOKEN")
	if token == "" {
		b, err := os.ReadFile(*tokenFile)
		if err != nil {
			slog.Error("no bot token", "err", err)
			os.Exit(1)
		}
		token = strings.TrimSpace(string(b))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	hc := &http.Client{Transport: bearer(token)}
	srv := sblurpv1connect.NewServerServiceClient(hc, *url)
	chat := sblurpv1connect.NewChatServiceClient(hc, *url)

	var me *v1.Member
	var last int64
	for wait := time.Second; ctx.Err() == nil; wait = min(wait*2, time.Minute) {
		if me == nil || last == 0 {
			st, err := srv.GetState(ctx, connect.NewRequest(&v1.GetStateRequest{}))
			if err != nil {
				slog.Error("get state", "err", err)
				sleep(ctx, wait)
				continue
			}
			me, last = st.Msg.Me, st.Msg.Seq
			slog.Info("connected", "bot", me.Username, "seq", last)
		}
		stream, err := srv.Subscribe(ctx, connect.NewRequest(&v1.SubscribeRequest{AfterSeq: last}))
		if err != nil {
			slog.Error("subscribe", "err", err)
			sleep(ctx, wait)
			continue
		}
		for stream.Receive() {
			wait = time.Second
			ev := stream.Msg()
			if ev.GetResync() {
				last = 0 // reload state on the next loop
				break
			}
			if ev.Seq != 0 {
				last = ev.Seq
			}
			m := ev.GetMessageCreated()
			if m == nil || m.AuthorId == me.Id || !strings.Contains(m.Text, "<@"+me.Id+">") {
				continue
			}
			text := reply(m.Text, time.Now(), rand.IntN)
			_, err := chat.SendMessage(ctx, connect.NewRequest(&v1.SendMessageRequest{
				ChannelId: m.ChannelId, ThreadRootId: m.ThreadRootId, Text: text, ClientId: "re-" + m.Id}))
			if err != nil {
				slog.Error("reply", "err", err)
			}
		}
		stream.Close()
		if ctx.Err() == nil {
			slog.Info("stream ended, reconnecting", "err", stream.Err())
			sleep(ctx, wait)
		}
	}
}

var (
	mentionRE = regexp.MustCompile(`<@[^>]+>`)
	diceRE    = regexp.MustCompile(`^(\d*)d(\d+)$`)
)

// reply answers a message that mentions the bot. intn(n) returns [0, n).
func reply(text string, now time.Time, intn func(int) int) string {
	words := strings.Fields(strings.ToLower(mentionRE.ReplaceAllString(text, " ")))
	cmd := ""
	if len(words) > 0 {
		cmd = words[0]
	}
	switch cmd {
	case "roll":
		spec := "d20"
		if len(words) > 1 {
			spec = words[1]
		}
		m := diceRE.FindStringSubmatch(spec)
		if m == nil {
			return "I roll dice like `d20` or `2d6`."
		}
		n, _ := strconv.Atoi(m[1])
		sides, _ := strconv.Atoi(m[2])
		n = max(n, 1)
		if n > 20 || sides < 2 || sides > 1000 {
			return "Up to 20 dice with 2 to 1000 sides, please."
		}
		total, rolls := 0, []string{}
		for range n {
			r := intn(sides) + 1
			total += r
			rolls = append(rolls, strconv.Itoa(r))
		}
		if n == 1 {
			return fmt.Sprintf("🎲 rolled %s: **%d**", spec, total)
		}
		return fmt.Sprintf("🎲 rolled %s: %s = **%d**", spec, strings.Join(rolls, " + "), total)
	case "time":
		return "🕰️ It is " + now.UTC().Format("15:04 MST, Monday 2 January") + "."
	default:
		return "Hi! I answer `help`, `roll d20` (or `2d6`), and `time`. Mention me with one of those."
	}
}

type bearer string

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
