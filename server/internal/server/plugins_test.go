package server

import (
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

var testPlugins = map[string]string{
	"loop.js": `
function onJoin(m) { if (m.username === "slowpoke") while (true) {} }
function onCommand(name) {
  if (name === "hang") while (true) {}
  if (name === "loopy") return "loop alive";
}`,
	"hog.js": `
function onCommand(name) {
  if (name === "hog") { let s = "x"; while (true) s = s + s; }
  if (name === "hoggy") return "hog alive";
}`,
	"boom.js": `
function onJoin() { throw new Error("join boom"); }
function onMessage() { throw new Error("message boom"); }
const onCommand = (name) => name === "boomy" ? { text: "boom alive" } : undefined;`,
	"echo.js": `
console.log("echo loaded");
// Replies in #general, so a message it should not have seen would show up there.
function onMessage(m) {
  if (m.text.startsWith("echo:")) return m.text; // would loop if bot messages ran hooks
  if (m.text === "hello bots") return { channel: "#general", text: "hi " + m.author.username + " in #" + m.channel.name }; }
every(5, () => ({ channel: "#general", text: "tick" }));`,
	"sandbox.js": `
let probe = "not run";
import("qjs:std").then(std => {
  probe = JSON.stringify([typeof globalThis.std, std.loadFile("/plugins.go"), std.loadFile("/etc/passwd"), std.open("/x.txt", "w"), std.getenv("HOME")]);
});
function onCommand(name) { if (name === "probe") return probe; }`,
	"Bad Name.js": `function onCommand() { return "should not load"; }`,
}

func (e *env) tokenWith(sub string, extra map[string]any) string {
	c := e.claims(sub)
	for k, v := range extra {
		c[k] = v
	}
	return signJWT(e.iss.key, map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": e.iss.kid}, c)
}

// logBuf is a goroutine-safe log sink.
type logBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestPlugins(t *testing.T) {
	logs := &logBuf{}
	e := newEnv(t, func(c *Config) {
		c.Logger = slog.New(slog.NewTextHandler(logs, nil))
		c.PluginTimeout = 300 * time.Millisecond
		c.PluginMemory = 8 << 20
		dir := filepath.Join(c.DataDir, "plugins")
		os.MkdirAll(dir, 0o700)
		dice, err := os.ReadFile("../../plugins/examples/dice.js")
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, "dice.js"), dice, 0o600)
		for name, src := range testPlugins {
			os.WriteFile(filepath.Join(dir, name), []byte(src), 0o600)
		}
	})

	// dice.js turns away people without a verified email, with its reason.
	_, err := e.client(e.token("ana")).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)
	if !strings.Contains(err.Error(), "Verify your email address") {
		t.Fatalf("reason not passed through: %v", err)
	}
	// boom.js throws in onJoin and is skipped; the join goes through.
	ana := e.client(e.tokenWith("ana", map[string]any{"email_verified": true}))
	ana.me = must(ana.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))).Member
	// loop.js hangs in onJoin for slowpoke; the hook is cut off and skipped.
	start := time.Now()
	must(e.client(e.tokenWith("slowpoke", map[string]any{"email_verified": true})).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{})))
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("hung onJoin held Join for %s", d)
	}

	// Each plugin is a bot named after its file; a bad file name is not loaded.
	var names []string
	for _, b := range must(ana.bots.ListBots(ctx(), connect.NewRequest(&v1.ListBotsRequest{}))).Bots {
		names = append(names, b.Username)
	}
	if got := strings.Join(names, ","); len(names) != 6 || strings.Contains(got, "Bad") {
		t.Fatalf("bots = %s", got)
	}

	general := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	sub := ana.subscribe(0)
	isBot := func(ev *v1.Event) bool {
		m := ev.GetMessageCreated()
		return m != nil && m.AuthorId != ana.me.Id
	}

	// /roll from the shipped example.
	ana.send(general.Id, "/roll 3d6")
	got := sub.next(isBot, nil).GetMessageCreated()
	m := regexp.MustCompile(`^ana rolled 3d6: (\d) \+ (\d) \+ (\d) = (\d+)$`).FindStringSubmatch(got.Text)
	if m == nil || got.ChannelId != general.Id {
		t.Fatalf("roll reply = %q", got.Text)
	}
	sum := 0
	for _, d := range m[1:4] {
		n, _ := strconv.Atoi(d)
		if n < 1 || n > 6 {
			t.Fatalf("die %d", n)
		}
		sum += n
	}
	if strconv.Itoa(sum) != m[4] {
		t.Fatalf("total in %q", got.Text)
	}

	// A plugin that loops forever, one that runs out of memory, and one that
	// throws (boom.js, on every message) are skipped, and each works again
	// on the next call. Hooks run one at a time, so replies come in order.
	for _, cmd := range []string{"/hang", "/hog", "/loopy", "/hoggy", "/boomy"} {
		must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: general.Id, Text: cmd})))
	}
	for _, want := range []string{"loop alive", "hog alive", "boom alive"} {
		if got := sub.next(isBot, nil).GetMessageCreated().Text; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
	// Each failure was logged for the reason it happened.
	for _, want := range []*regexp.Regexp{
		regexp.MustCompile(`plugin=loop hook=onCommand err="took longer than 300ms"`),
		regexp.MustCompile(`plugin=hog hook=onCommand err=".*out of memory`),
		regexp.MustCompile(`plugin=boom hook=onMessage err=".*message boom`),
		regexp.MustCompile(`plugin=boom hook=onJoin err=".*join boom`),
		regexp.MustCompile(`msg="plugin not loaded" plugin="Bad Name"`),
		regexp.MustCompile(`msg="plugin log" plugin=echo msg="echo loaded"`),
	} {
		if !want.MatchString(logs.String()) {
			t.Errorf("log lacks %s:\n%s", want, logs)
		}
	}

	// onMessage replies, but plugins never see channels their bot cannot see
	// (a private one, and one gated by a role the bot lacks).
	ana.send(secret.Id, "hello bots")
	role := must(ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "Humans"}))).Role
	gated := ana.channel("gated", v1.ChannelKind_CHANNEL_KIND_TEXT)
	if err := ana.setAccess(gated.Id, false, role.Id); err != nil {
		t.Fatal(err)
	}
	ana.send(gated.Id, "hello bots")
	ana.send(general.Id, "hello bots")
	if got := sub.next(isBot, nil).GetMessageCreated(); got.Text != "hi ana in #general" || got.ChannelId != general.Id {
		t.Fatalf("echo reply = %q in %s", got.Text, got.ChannelId)
	}

	// The sandbox: no files (not even its own mount), no env, no std global.
	ana.send(general.Id, "/probe")
	if got := sub.next(isBot, nil).GetMessageCreated().Text; got != `["undefined",null,null,null,null]` {
		t.Fatalf("probe = %s", got)
	}

	// every(5, fn) posts to #general once five minutes have passed.
	e.clock.Advance(4 * time.Minute)
	e.s.pluginTick()
	e.clock.Advance(time.Minute)
	e.s.pluginTick()
	ana.send(general.Id, "/loopy")
	var seen []*v1.Event
	sub.next(func(ev *v1.Event) bool { return ev.GetMessageCreated().GetText() == "loop alive" }, &seen)
	ticks := 0
	for _, ev := range seen {
		if ev.GetMessageCreated().GetText() == "tick" {
			ticks++
		}
	}
	if ticks != 1 {
		t.Fatalf("got %d ticks, want 1", ticks)
	}

	// Bot messages do not run hooks (so bots cannot loop): echo answers ana
	// once and an outside bot not at all.
	ana.send(general.Id, "echo: once")
	robo := e.client(must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"}))).Token)
	robo.send(general.Id, "echo: once")
	e.clock.Advance(time.Minute)
	ana.send(general.Id, "/loopy")
	seen = nil
	sub.next(func(ev *v1.Event) bool { return ev.GetMessageCreated().GetText() == "loop alive" }, &seen)
	echoes := 0
	for _, ev := range seen {
		if m := ev.GetMessageCreated(); m.GetText() == "echo: once" {
			echoes++
		}
	}
	if echoes != 3 { // ana's, robo's and one reply
		t.Fatalf("got %d echo messages, want 3", echoes)
	}
}
