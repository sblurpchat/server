package server

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// bulkFill writes n messages straight into the database: 10 text channels,
// 500 members (all in every channel), 10% thread replies, reactions on 20%,
// an attachment on 5%, a mention of me on 5%. Only the newest 20,000 get
// events, like a server that prunes. It returns the channel ids.
func bulkFill(t *testing.T, e *env, me, bot string, n int) []string {
	t.Helper()
	cx := context.Background()
	tx, err := e.s.db.w.BeginTx(cx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	exec := func(q string, args ...any) {
		if _, err := tx.ExecContext(cx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	var seq int64
	if err := tx.QueryRowContext(cx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)").Scan(&seq); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewPCG(1, 2))
	start := e.clock.Now().Add(-365 * 24 * time.Hour)
	members := []string{me, bot}
	for i := range 500 {
		id := newID(start)
		members = append(members, id)
		exec("INSERT INTO members(id, kind, role, username, display_name, joined_at_ms) VALUES (?,?,?,?,?,?)",
			id, v1.MemberKind_MEMBER_KIND_HUMAN, v1.MemberRole_MEMBER_ROLE_MEMBER, fmt.Sprintf("user%d", i), fmt.Sprintf("User %d", i), start.UnixMilli())
	}
	var channels []string
	for i := range 10 {
		id := newID(start)
		channels = append(channels, id)
		exec("INSERT INTO channels(id, kind, name, created_at_ms) VALUES (?,?,?,?)", id, v1.ChannelKind_CHANNEL_KIND_TEXT, fmt.Sprintf("big%d", i), start.UnixMilli())
		for _, m := range members {
			exec("INSERT INTO channel_members(channel_id, member_id) VALUES (?,?)", id, m)
		}
	}
	words := strings.Fields("the a deploy server bug fix release coffee lunch meeting review merge branch test flaky green red build ship today tomorrow yesterday please thanks sqlite index query slow fast cache memory cpu disk network latency queue worker cron backup restore pager alert incident postmortem design doc spec ticket board sprint demo")
	ins, err := tx.PrepareContext(cx, `INSERT INTO messages(id, channel_id, author_id, text, created_at_ms, thread_root_id, created_seq, seq) VALUES (?,?,?,?,?,?,?,?)`)
	if err != nil {
		t.Fatal(err)
	}
	insEv, _ := tx.PrepareContext(cx, "INSERT INTO events(seq, at_ms, scope_channel, payload) VALUES (?,?,?,?)")
	insRe, _ := tx.PrepareContext(cx, "INSERT OR IGNORE INTO reactions(message_id, emoji, member_id, at_ms) VALUES (?,?,?,?)")
	insAt, _ := tx.PrepareContext(cx, "INSERT INTO attachments(id, uploader_id, message_id, name, content_type, size, created_at_ms) VALUES (?,?,?,?,?,?,?)")
	lastRoot := map[string]string{}
	replies := map[string]int{}
	lastTop := map[string]int64{}
	step := 365 * 24 * time.Hour / time.Duration(n)
	for i := range n {
		at := start.Add(time.Duration(i) * step)
		ch := channels[rng.IntN(len(channels))]
		author := members[1+rng.IntN(len(members)-1)]
		var b strings.Builder
		for range 4 + rng.IntN(12) {
			b.WriteString(words[rng.IntN(len(words))])
			b.WriteByte(' ')
		}
		if rng.IntN(20) == 0 {
			b.WriteString("<@" + me + ">")
		}
		root := ""
		if r := lastRoot[ch]; r != "" && rng.IntN(10) == 0 {
			root = r
		}
		seq++
		id := newID(at)
		if _, err := ins.ExecContext(cx, id, ch, author, b.String(), at.UnixMilli(), root, seq, seq); err != nil {
			t.Fatal(err)
		}
		if root == "" {
			lastRoot[ch], lastTop[ch] = id, seq
		} else {
			replies[root]++
		}
		if rng.IntN(5) == 0 {
			for range 1 + rng.IntN(3) {
				insRe.ExecContext(cx, id, []string{"👍", "🎉", "😂", ":party_parrot:"}[rng.IntN(4)], members[rng.IntN(len(members))], at.UnixMilli())
			}
		}
		if rng.IntN(20) == 0 {
			insAt.ExecContext(cx, newID(at), author, id, "shot.png", "image/png", 12345, at.UnixMilli())
		}
		if n-i <= 20000 {
			ev, _ := proto.Marshal(&v1.Event{Seq: seq, AtMs: at.UnixMilli(), Kind: &v1.Event_MessageCreated{MessageCreated: &v1.Message{Id: id, ChannelId: ch, AuthorId: author, Text: b.String(), CreatedAtMs: at.UnixMilli(), ThreadRootId: root, Seq: seq, CreatedSeq: seq}}})
			if _, err := insEv.ExecContext(cx, seq, at.UnixMilli(), ch, ev); err != nil {
				t.Fatal(err)
			}
		}
	}
	for id, c := range replies {
		exec("UPDATE messages SET reply_count = ? WHERE id = ?", c, id)
	}
	for ch, s := range lastTop {
		exec("UPDATE channels SET last_message_seq = ? WHERE id = ?", s, ch)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return channels
}

// TestPerf measures the hot paths against a big database. It is slow, so it
// runs only with SBLURP_PERF=<messages>, for example:
//
//	SBLURP_PERF=1000000 go test -run TestPerf -v -cpuprofile cpu.out ./internal/server
func TestPerf(t *testing.T) {
	n, _ := strconv.Atoi(os.Getenv("SBLURP_PERF"))
	if n == 0 {
		t.Skip("set SBLURP_PERF=<messages> to run")
	}
	e := newEnv(t, func(c *Config) {
		if d := os.Getenv("SBLURP_PERF_DIR"); d != "" {
			c.DataDir = d
		}
	})
	me := e.join("me")
	bot := must(me.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "loadbot", DisplayName: "Load"})))
	t0 := time.Now()
	chans := bulkFill(t, e, me.me.Id, bot.Bot.Id, n)
	t.Logf("fill %d messages: %v", n, time.Since(t0).Round(time.Millisecond))
	// Caught up everywhere but the last 100 messages of each channel.
	for _, c := range chans {
		var s int64
		e.s.db.r.QueryRow("SELECT created_seq FROM messages WHERE channel_id = ? ORDER BY created_seq DESC LIMIT 1 OFFSET 100", c).Scan(&s)
		e.s.db.w.Exec("INSERT INTO read_states(member_id, channel_id, last_read_seq) VALUES (?,?,?)", me.me.Id, c, s)
	}
	ch := chans[0]
	var deep string
	e.s.db.r.QueryRow("SELECT id FROM messages WHERE channel_id = ? AND thread_root_id = '' ORDER BY created_seq LIMIT 1 OFFSET 1000", ch).Scan(&deep)
	newest, _ := currentSeq(ctx(), e.s.db.r)

	bench := func(name string, fn func()) {
		r := testing.Benchmark(func(b *testing.B) {
			for b.Loop() {
				fn()
			}
		})
		t.Logf("%-28s %8.2f ms/op %8d allocs/op %8d KB/op", name, float64(r.NsPerOp())/1e6, r.AllocsPerOp(), r.AllocedBytesPerOp()/1024)
	}
	bench("ListMessages latest", func() {
		must(me.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: ch})))
	})
	bench("ListMessages deep page", func() {
		must(me.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: ch, BeforeId: deep})))
	})
	bench("GetState (unread counts)", func() { me.state() })
	bench("Search common word", func() {
		must(me.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "deploy"})))
	})
	bench("Search rare phrase", func() {
		must(me.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "postmortem sqlite"})))
	})
	bench("Search in channel", func() {
		must(me.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "deploy", ChannelId: ch})))
	})
	bench("Subscribe resume 10k gap", func() {
		cx, cancel := context.WithCancel(ctx())
		defer cancel()
		st, err := me.srv.Subscribe(cx, connect.NewRequest(&v1.SubscribeRequest{AfterSeq: newest - 10000}))
		if err != nil {
			t.Fatal(err)
		}
		for st.Receive() {
			if st.Msg().Seq == newest {
				return
			}
		}
		t.Fatal(st.Err())
	})
	botc := e.client(bot.Token)
	var sent atomic.Int64
	r := testing.Benchmark(func(b *testing.B) {
		b.SetParallelism(4)
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				i := sent.Add(1)
				must(botc.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: chans[i%10], Text: "load " + strconv.FormatInt(i, 10)})))
			}
		})
	})
	t.Logf("%-28s %8.2f ms/op (%.0f msg/s)", "SendMessage parallel", float64(r.NsPerOp())/1e6, 1e9/float64(r.NsPerOp()))

	// Retention to 180 days expires about half of it.
	e.s.db.w.Exec("INSERT INTO settings(key, value) VALUES ('retention_days', '180')")
	prunePause = 0
	t0 = time.Now()
	if err := e.s.pruneMessages(ctx()); err != nil {
		t.Fatal(err)
	}
	t.Logf("%-28s %8.2f s", "pruneMessages half", time.Since(t0).Seconds())
}

// TestQueryPlans guards the 1155 fixes: on a big community these queries
// scanned a whole channel, the whole table, or sorted every search match.
// FTS5 index 192 is ORDER BY rowid DESC, so the search stops at its limit.
func TestQueryPlans(t *testing.T) {
	e := newEnv(t)
	for name, c := range map[string]struct {
		sql  string
		args []any
		want string
	}{
		"unread":         {unreadCounts, []any{false, "x", "c", 1, "m"}, "messages_unread (channel_id=? AND created_seq>?)"},
		"expired":        {expiredIDs, []any{1, 1}, "messages_thread (thread_root_id=?)"},
		"search mine":    {"SELECT n FROM messages WHERE " + fmt.Sprintf(searchWhere, searchMine), []any{"x", 0, "m", 20}, "SCAN f VIRTUAL TABLE INDEX 192:"},
		"search channel": {"SELECT n FROM messages WHERE " + fmt.Sprintf(searchWhere, "?"), []any{"x", 0, "c", 20}, "SCAN f VIRTUAL TABLE INDEX 192:"},
	} {
		rows, err := e.s.db.r.Query("EXPLAIN QUERY PLAN "+c.sql, c.args...)
		if err != nil {
			t.Fatal(name, err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			rows.Scan(&id, &parent, &unused, &detail)
			plan = append(plan, detail)
		}
		rows.Close()
		all := strings.Join(plan, "\n")
		if !strings.Contains(all, c.want) || strings.Contains(all, "SCAN messages") {
			t.Errorf("%s plan:\n%s\nwant %q and no full scan", name, all, c.want)
		}
	}
}
