package server

import (
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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

// Verification plugins (1002): a plugin asks a question with joinQuestion and
// checks member.answer in onJoin. Answers go to the plugins in order.
func TestJoinQuestions(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		dir := filepath.Join(c.DataDir, "plugins")
		os.MkdirAll(dir, 0o700)
		for name, src := range map[string]string{
			"a-riddle.js": `const joinQuestion = "What has keys but opens no locks?";
function onJoin(m) { if (m.answer.toLowerCase() !== "a piano") return { allow: false, reason: "Not quite. Try again." }; }`,
			"b-plain.js": `function onJoin(m) { if ("answer" in m) return { allow: false, reason: "plain got an answer" }; }`,
			"c-rules.js": `var joinQuestion = "Type 'I agree' to accept the rules.";
function onJoin(m) { if (m.answer !== "I agree") return { allow: false, reason: "Please accept the rules." }; }`,
			"d-bad.js": `var joinQuestion = "two\nlines";`,
		} {
			os.WriteFile(filepath.Join(dir, name), []byte(src), 0o600)
		}
	})
	info := must(e.client("").srv.GetServerInfo(ctx(), connect.NewRequest(&v1.GetServerInfoRequest{})))
	if want := []string{"What has keys but opens no locks?", "Type 'I agree' to accept the rules."}; !slices.Equal(info.JoinQuestions, want) {
		t.Fatalf("join_questions = %q", info.JoinQuestions)
	}
	join := func(answers ...string) error {
		_, err := e.client(e.token("ana")).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{Answers: answers}))
		return err
	}
	for _, c := range []struct {
		answers []string
		reason  string
	}{
		{nil, "Not quite"},
		{[]string{"a piano"}, "Please accept the rules"},
		{[]string{"I agree", "a piano"}, "Not quite"}, // order matters
	} {
		err := join(c.answers...)
		wantCode(t, err, connect.CodePermissionDenied)
		if !strings.Contains(err.Error(), c.reason) {
			t.Fatalf("answers %q: %v", c.answers, err)
		}
	}
	wantCode(t, join("1", "2", "3", "4"), connect.CodeInvalidArgument)
	if err := join(" A Piano ", "I agree"); err != nil { // answers are trimmed
		t.Fatalf("right answers refused: %v", err)
	}
}

func TestPluginAdmin(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.PluginTimeout = 300 * time.Millisecond
		dir := filepath.Join(c.DataDir, "plugins")
		os.MkdirAll(dir, 0o700)
		os.WriteFile(filepath.Join(dir, "broken.js"), []byte("function ("), 0o600)
	})
	ana, bob := e.join("ana"), e.join("bob")
	dir := filepath.Join(e.dir, "plugins")
	install := func(c *client, name, src string) (*v1.Plugin, error) {
		r, err := c.bots.InstallPlugin(ctx(), connect.NewRequest(&v1.InstallPluginRequest{Name: name, Source: src}))
		if err != nil {
			return nil, err
		}
		return r.Msg.Plugin, nil
	}
	setEnabled := func(name string, on bool) *v1.Plugin {
		t.Helper()
		return must(ana.bots.SetPluginEnabled(ctx(), connect.NewRequest(&v1.SetPluginEnabledRequest{Name: name, Enabled: on}))).Plugin
	}
	list := func() map[string]*v1.Plugin {
		t.Helper()
		out := map[string]*v1.Plugin{}
		for _, p := range must(ana.bots.ListPlugins(ctx(), connect.NewRequest(&v1.ListPluginsRequest{}))).Plugins {
			out[p.Name] = p
		}
		return out
	}

	// A file that failed to load at startup is listed with its error.
	if p := list()["broken"]; p == nil || p.Running || !p.Enabled || p.Error == "" {
		t.Fatalf("broken = %v", p)
	}

	// Members cannot see or change plugins.
	_, err := bob.bots.ListPlugins(ctx(), connect.NewRequest(&v1.ListPluginsRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = install(bob, "hi", `function onCommand() { return "x"; }`)
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = bob.bots.SetPluginEnabled(ctx(), connect.NewRequest(&v1.SetPluginEnabledRequest{Name: "broken"}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = bob.bots.DeletePlugin(ctx(), connect.NewRequest(&v1.DeletePluginRequest{Name: "broken"}))
	wantCode(t, err, connect.CodePermissionDenied)

	// Names must be safe file names; source has a size cap.
	for _, name := range []string{"../evil", "a/b", "x", "Has Space", ""} {
		_, err = install(ana, name, `1`)
		wantCode(t, err, connect.CodeInvalidArgument)
	}
	_, err = install(ana, "big", "//"+strings.Repeat("x", 256<<10))
	wantCode(t, err, connect.CodeInvalidArgument)

	general := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	sub := ana.subscribe(ana.state().Seq)
	isBot := func(ev *v1.Event) bool {
		m := ev.GetMessageCreated()
		return m != nil && m.AuthorId != ana.me.Id
	}
	reply := func(cmds ...string) string {
		t.Helper()
		for _, c := range cmds {
			ana.send(general.Id, c)
		}
		return sub.next(isBot, nil).GetMessageCreated().Text
	}

	// Install hot-loads it as a bot, with no restart; admins get an event.
	p, err := install(ana, "Hi.js", `function onCommand(n) { if (n === "hi") return "v1"; }`)
	if err != nil || p.Name != "hi" || !p.Running || !p.Enabled || p.BotId == "" {
		t.Fatalf("install = %v, %v", p, err)
	}
	sub.next(func(ev *v1.Event) bool { return ev.GetPluginsChanged() }, nil)
	if _, err := install(ana, "ping", `function onCommand(n) { if (n === "ping") return "pong"; if (n === "boom") throw new Error("kaboom"); }`); err != nil {
		t.Fatal(err)
	}
	if got := reply("/hi"); got != "v1" {
		t.Fatalf("hi = %q", got)
	}

	// A script that does not compile, or hangs at the top level, is refused
	// and the old one keeps running from the same file.
	for _, src := range []string{"function (", "while (true) {}", `throw new Error("no")`} {
		_, err = install(ana, "hi", src)
		wantCode(t, err, connect.CodeInvalidArgument)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "hi.js")); !strings.Contains(string(b), "v1") {
		t.Fatalf("hi.js = %s", b)
	}
	if got := reply("/hi"); got != "v1" {
		t.Fatalf("hi after bad install = %q", got)
	}

	// Replace swaps the code in place and keeps the bot.
	p2, err := install(ana, "hi", `function onCommand(n) { if (n === "hi") return "v2"; }`)
	if err != nil || p2.BotId != p.BotId {
		t.Fatalf("replace = %v, %v (bot was %s)", p2, err, p.BotId)
	}
	if got := reply("/hi"); got != "v2" {
		t.Fatalf("hi after replace = %q", got)
	}

	// Disable stops it (the next reply is ping's) and keeps the file aside.
	if p := setEnabled("hi", false); p.Enabled || p.Running || p.BotId != p2.BotId {
		t.Fatalf("disabled = %v", p)
	}
	if _, err := os.Stat(filepath.Join(dir, "hi.js.disabled")); err != nil {
		t.Fatal(err)
	}
	if got := reply("/hi", "/ping"); got != "pong" {
		t.Fatalf("disabled plugin replied %q", got)
	}
	if p := setEnabled("hi", true); !p.Enabled || !p.Running {
		t.Fatalf("enabled = %v", p)
	}
	if got := reply("/hi"); got != "v2" {
		t.Fatalf("hi after enable = %q", got)
	}

	// A hook failure shows as the plugin's error.
	if got := reply("/boom", "/ping"); got != "pong" {
		t.Fatalf("got %q", got)
	}
	if p := list()["ping"]; !p.Running || !strings.Contains(p.Error, "kaboom") {
		t.Fatalf("ping = %v", p)
	}

	// A plugin's bot cannot be deleted or given a token as a token bot,
	// whether the plugin is on or off.
	_, err = ana.bots.DeleteBot(ctx(), connect.NewRequest(&v1.DeleteBotRequest{BotId: p.BotId}))
	wantCode(t, err, connect.CodeFailedPrecondition)
	if !strings.Contains(err.Error(), "delete or turn off the plugin") {
		t.Fatalf("DeleteBot error = %v", err)
	}
	setEnabled("hi", false)
	_, err = ana.bots.RotateBotToken(ctx(), connect.NewRequest(&v1.RotateBotTokenRequest{BotId: p.BotId}))
	wantCode(t, err, connect.CodeFailedPrecondition)
	setEnabled("hi", true)

	// Delete removes the file and the bot.
	must(ana.bots.DeletePlugin(ctx(), connect.NewRequest(&v1.DeletePluginRequest{Name: "hi"})))
	if _, err := os.Stat(filepath.Join(dir, "hi.js")); !os.IsNotExist(err) {
		t.Fatalf("hi.js still there: %v", err)
	}
	if _, ok := list()["hi"]; ok {
		t.Fatal("hi still listed")
	}
	for _, b := range must(ana.bots.ListBots(ctx(), connect.NewRequest(&v1.ListBotsRequest{}))).Bots {
		if b.Id == p.BotId {
			t.Fatal("hi's bot not deleted")
		}
	}
	if got := reply("/hi", "/ping"); got != "pong" {
		t.Fatalf("deleted plugin replied %q", got)
	}
	_, err = ana.bots.DeletePlugin(ctx(), connect.NewRequest(&v1.DeletePluginRequest{Name: "hi"}))
	wantCode(t, err, connect.CodeNotFound)
}
