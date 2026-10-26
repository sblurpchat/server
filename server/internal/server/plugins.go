package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/fastschema/qjs"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Plugins are JavaScript files in <data>/plugins, run by QuickJS compiled to
// WebAssembly (github.com/fastschema/qjs on wazero, no CGO). Each plugin acts
// as a bot member named after its file. See server/README.md for the API.

const (
	defaultPluginMemory  = 32 << 20
	defaultPluginTimeout = time.Second
	maxReasonChars       = 200
	maxQuestionChars     = 200
	maxAnswerChars       = 1000
)

// prelude runs before the plugin's own code. It hides QuickJS's std and os
// modules (the real sandbox is the WASI mount, see newRuntime) and adds
// every().
const prelude = `"use strict";
for (const k of ["std", "os", "bjson", "setTimeout", "setInterval", "clearTimeout", "clearInterval"]) delete globalThis[k];
globalThis.__sb = {
  timers: [],
  run(fn, args) { return JSON.stringify((typeof fn === "function" ? fn(...args) : null) ?? null); },
};
globalThis.every = (minutes, fn) => {
  if (!(minutes >= 1) || typeof fn !== "function") throw new TypeError("every(minutes >= 1, fn)");
  __sb.timers.push({ minutes: Math.floor(minutes), fn });
};
`

var commandRE = regexp.MustCompile(`^/([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$`)

type plugin struct {
	name, src string
	botID     string

	mu       sync.Mutex
	rt       *qjs.Runtime
	cancel   context.CancelFunc
	timers   []pluginTimer
	question string // the plugin's joinQuestion, if any
	err      string // last hook failure
	removed  bool   // replaced, disabled or deleted; never start it again
}

type pluginTimer struct {
	every time.Duration
	next  time.Time
}

// pluginReply is what a hook may return: a string, or {text, channel}.
// onJoin returns {allow, reason} instead.
type pluginReply struct {
	Text    string `json:"text"`
	Channel string `json:"channel"`
	Allow   *bool  `json:"allow"`
	Reason  string `json:"reason"`
}

func (r *pluginReply) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		return json.Unmarshal(b, &r.Text)
	}
	type plain pluginReply
	return json.Unmarshal(b, (*plain)(r))
}

// loadPlugins loads every <data>/plugins/*.js and starts the worker that
// runs message and schedule hooks. A plugin that fails to load is logged and
// left out.
func (s *Server) loadPlugins() {
	s.pluginJobs = make(chan func(), 256)
	s.pluginErrs = map[string]string{}
	files, _ := filepath.Glob(filepath.Join(s.pluginDir(), "*.js"))
	for _, f := range files {
		s.loadPluginFile(strings.TrimSuffix(filepath.Base(f), ".js"))
	}
	s.wg.Add(1)
	go s.pluginLoop()
}

func (s *Server) pluginDir() string { return filepath.Join(s.cfg.DataDir, "plugins") }

// loadPluginFile (re)starts <name>.js in place of any running copy. A
// failure is logged and kept for ListPlugins.
func (s *Server) loadPluginFile(name string) {
	src, err := os.ReadFile(filepath.Join(s.pluginDir(), name+".js"))
	var p *plugin
	if err == nil {
		p, err = s.preparePlugin(name, string(src))
	}
	if err != nil {
		s.log.Error("plugin not loaded", "plugin", name, "err", err)
		s.swapPlugin(name, nil)
		s.pluginsMu.Lock()
		s.pluginErrs[name] = firstLine(err.Error())
		s.pluginsMu.Unlock()
		return
	}
	s.log.Info("plugin loaded", "plugin", name, "bot", p.botID, "timers", len(p.timers))
	s.swapPlugin(name, p)
}

// preparePlugin runs src's top level and finds or creates its bot. Nothing
// is swapped in yet; on error nothing has changed but maybe a new bot.
func (s *Server) preparePlugin(name, src string) (*plugin, error) {
	if !usernameRE.MatchString(name) {
		return nil, errors.New("file name must be a valid username (2 to 32 of a-z, 0-9, _, . and -)")
	}
	p := &plugin{name: name, src: src}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := s.startPlugin(p); err != nil {
		return nil, err
	}
	if err := s.pluginBot(p); err != nil {
		stopRuntime(p)
		return nil, err
	}
	return p, nil
}

// swapPlugin puts p (nil to remove) in place of the plugin called name and
// stops the old one.
func (s *Server) swapPlugin(name string, p *plugin) {
	s.pluginsMu.Lock()
	var old *plugin
	if i := slices.IndexFunc(s.plugins, func(x *plugin) bool { return x.name == name }); i >= 0 {
		old = s.plugins[i]
		s.plugins = slices.Delete(s.plugins, i, i+1)
	}
	if p != nil {
		s.plugins = append(s.plugins, p)
		slices.SortFunc(s.plugins, func(a, b *plugin) int { return strings.Compare(a.name, b.name) })
	}
	delete(s.pluginErrs, name)
	s.pluginsMu.Unlock()
	if old != nil {
		old.mu.Lock()
		old.removed = true
		stopRuntime(old)
		old.mu.Unlock()
	}
}

// pluginList is a snapshot of the running plugins, sorted by name.
func (s *Server) pluginList() []*plugin {
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	return slices.Clone(s.plugins)
}

// pluginBot finds or creates the plugin's bot member. Nobody ever sees the
// bot's token, so only the plugin can speak as it.
func (s *Server) pluginBot(p *plugin) error {
	return s.writeTx(context.Background(), func(t *wtx) error {
		m, err := s.loadMember(t.ctx, t, "username = ? AND deleted = 0", p.name)
		if err != nil {
			return err
		}
		if m != nil {
			if m.Kind != v1.MemberKind_MEMBER_KIND_BOT {
				return fmt.Errorf("username %q belongs to a person", p.name)
			}
			p.botID = m.Id
			return nil
		}
		bot, _, err := s.createBot(t, p.name, p.name, "", "Plugin "+p.name+".js", s.now())
		if err == nil {
			p.botID = bot.Id
		}
		return err
	})
}

// startPlugin (re)creates the plugin's runtime and runs its source. Hold p.mu.
func (s *Server) startPlugin(p *plugin) error {
	stopRuntime(p)
	ctx, cancel := context.WithCancel(context.Background())
	logw := pluginLog{s, p.name}
	rt, err := qjs.New(qjs.Option{
		// WASI mounts this as the plugin's "/". Nothing can exist under
		// /dev/null, so every file open fails, even when run as root.
		CWD:                "/dev/null",
		Context:            ctx,
		CloseOnContextDone: true,
		MemoryLimit:        s.cfg.PluginMemory,
		Stdout:             logw,
		Stderr:             logw,
	})
	if err != nil {
		cancel()
		return err
	}
	p.rt, p.cancel = rt, cancel
	var loaded struct {
		Minutes  []int
		Question string
	}
	if _, err := s.evalPlugin(p, prelude+p.src+`
;JSON.stringify({minutes: __sb.timers.map(t => t.minutes), question: typeof joinQuestion === "string" ? joinQuestion : ""})`, &loaded); err != nil {
		stopRuntime(p)
		return err
	}
	p.question = strings.TrimSpace(loaded.Question)
	if err := checkText("joinQuestion", p.question, maxQuestionChars, true); err != nil {
		stopRuntime(p)
		return err
	}
	now := s.now()
	p.timers = p.timers[:0]
	for _, m := range loaded.Minutes {
		d := time.Duration(m) * time.Minute
		p.timers = append(p.timers, pluginTimer{every: d, next: now.Add(d)})
	}
	return nil
}

// evalPlugin runs code that ends in a JSON string, under the time limit, and
// decodes the result into out. A hung or crashed runtime is thrown away and
// the plugin is started again. Hold p.mu.
func (s *Server) evalPlugin(p *plugin, code string, out any) (dead bool, err error) {
	if p.rt == nil {
		return true, errors.New("plugin is not running")
	}
	timer := time.AfterFunc(s.cfg.PluginTimeout, p.cancel)
	var res string
	func() {
		defer func() {
			if r := recover(); r != nil {
				dead, err = true, fmt.Errorf("runtime crashed: %v", firstLine(fmt.Sprint(r)))
			}
		}()
		v, e := p.rt.Context().Eval(p.name+".js", qjs.Code(code))
		if e != nil {
			err = e
			return
		}
		res = v.String()
		v.Free()
	}()
	if !timer.Stop() {
		dead, err = true, fmt.Errorf("took longer than %s", s.cfg.PluginTimeout)
	}
	if dead {
		stopRuntime(p)
		return true, err
	}
	if err != nil {
		return false, err
	}
	return false, json.Unmarshal([]byte(res), out)
}

// callPlugin calls a hook and logs failures. ok is false when the hook threw,
// hung, ran out of memory or returned junk; the caller then skips the plugin.
func (s *Server) callPlugin(p *plugin, hook string, args ...any) (reply pluginReply, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.removed {
		return reply, false
	}
	if p.rt == nil {
		if err := s.startPlugin(p); err != nil {
			s.log.Error("plugin restart failed", "plugin", p.name, "err", err)
			return reply, false
		}
	}
	if args == nil {
		args = []any{}
	}
	a, err := json.Marshal(args)
	if err != nil {
		return reply, false
	}
	fn := hook
	if !strings.HasPrefix(hook, "__sb.") {
		fn = "(typeof " + hook + " === \"function\" ? " + hook + " : null)"
	}
	var out *pluginReply
	dead, err := s.evalPlugin(p, "__sb.run("+fn+", "+string(a)+")", &out)
	if err != nil {
		s.log.Warn("plugin hook failed", "plugin", p.name, "hook", hook, "err", firstLine(err.Error()))
		p.err = hook + ": " + firstLine(err.Error())
		if dead {
			// Start it again now so its timers and state are back for the next call.
			if err := s.startPlugin(p); err != nil {
				s.log.Error("plugin restart failed", "plugin", p.name, "err", err)
			}
		}
		return reply, false
	}
	if out != nil {
		reply = *out
	}
	return reply, true
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

type pluginLog struct {
	s    *Server
	name string
}

func (l pluginLog) Write(b []byte) (int, error) {
	l.s.log.Info("plugin log", "plugin", l.name, "msg", strings.TrimRight(string(b), "\n"))
	return len(b), nil
}

// joinQuestions lists the plugins' join questions, in plugin order.
func (s *Server) joinQuestions() []string {
	var qs []string
	for _, p := range s.pluginList() {
		p.mu.Lock()
		if p.question != "" {
			qs = append(qs, p.question)
		}
		p.mu.Unlock()
	}
	return qs
}

// pluginJoin runs every onJoin hook. The first {allow: false} turns the
// person away with its reason. A hook that fails is skipped. A plugin with a
// joinQuestion gets the matching entry of answers as member.answer.
func (s *Server) pluginJoin(id *identity, display string, answers []string) error {
	plugins := s.pluginList()
	if len(answers) > len(plugins) {
		return errf(connect.CodeInvalidArgument, "too many answers")
	}
	for _, a := range answers {
		if err := checkText("answers", a, maxAnswerChars, false); err != nil {
			return err
		}
	}
	n := 0
	for _, p := range plugins {
		m := map[string]any{
			"iss": id.iss, "sub": id.sub, "username": id.username, "display_name": display,
			"email_verified": id.emailVerified, "age_over_13": id.ageOver13, "age_over_18": id.ageOver18,
		}
		p.mu.Lock()
		asks := p.question != ""
		p.mu.Unlock()
		if asks {
			m["answer"] = ""
			if n < len(answers) {
				m["answer"] = strings.TrimSpace(answers[n])
			}
			n++
		}
		r, ok := s.callPlugin(p, "onJoin", m)
		if !ok || r.Allow == nil || *r.Allow {
			continue
		}
		reason := strings.TrimSpace(r.Reason)
		if reason == "" {
			reason = "this community did not accept your join"
		}
		if len([]rune(reason)) > maxReasonChars {
			reason = string([]rune(reason)[:maxReasonChars])
		}
		s.log.Info("join refused by plugin", "plugin", p.name, "iss", id.iss, "sub", id.sub)
		return errf(connect.CodePermissionDenied, "%s", reason)
	}
	return nil
}

// pluginMessage queues onMessage, and onCommand for "/name args", for a new
// message. Plugins only see messages in channels their bot can see.
func (s *Server) pluginMessage(author *memberRow, msg *v1.Message) {
	if len(s.pluginList()) == 0 || author.Kind == v1.MemberKind_MEMBER_KIND_BOT {
		return
	}
	s.queuePlugin(func() {
		c, err := channelFor(context.Background(), s.db.r, msg.ChannelId, author.Id)
		if err != nil {
			return
		}
		who := map[string]any{"id": author.Id, "username": author.Username, "display_name": author.DisplayName}
		where := map[string]any{"id": c.Id, "name": c.Name}
		cmd := commandRE.FindStringSubmatch(msg.Text)
		for _, p := range s.pluginList() {
			if _, err := channelFor(context.Background(), s.db.r, c.Id, p.botID); err != nil {
				continue
			}
			if r, ok := s.callPlugin(p, "onMessage", map[string]any{
				"id": msg.Id, "text": msg.Text, "thread_root_id": msg.ThreadRootId, "author": who, "channel": where,
			}); ok {
				s.pluginSend(p, r, c.Id, msg.ThreadRootId)
			}
			if cmd != nil {
				if r, ok := s.callPlugin(p, "onCommand", cmd[1], strings.TrimSpace(cmd[2]), map[string]any{
					"message_id": msg.Id, "thread_root_id": msg.ThreadRootId, "author": who, "channel": where,
				}); ok {
					s.pluginSend(p, r, c.Id, msg.ThreadRootId)
				}
			}
		}
	})
}

func (s *Server) queuePlugin(job func()) {
	select {
	case s.pluginJobs <- job:
	default:
		s.log.Warn("plugin queue full, dropping a hook call")
	}
}

// pluginSend posts a hook's reply as the plugin's bot, in r.Channel (a name)
// if set, otherwise in channelID.
func (s *Server) pluginSend(p *plugin, r pluginReply, channelID, threadID string) {
	text := strings.TrimSpace(r.Text)
	if text == "" {
		return
	}
	err := checkText("text", text, maxMessageChars, false)
	if err == nil && r.Channel != "" {
		threadID = ""
		var cs []*v1.Channel
		cs, err = queryChannels(context.Background(), s.db.r, "name = ? AND kind != ?", strings.TrimPrefix(r.Channel, "#"), v1.ChannelKind_CHANNEL_KIND_DM)
		if err == nil && len(cs) == 0 {
			err = fmt.Errorf("no channel #%s", r.Channel)
		}
		if err == nil {
			channelID = cs[0].Id
		}
	}
	if err == nil && channelID == "" {
		err = errors.New("reply has no channel")
	}
	if err == nil {
		var msg *v1.Message
		err = s.writeTx(context.Background(), func(t *wtx) error {
			msg, err = s.sendMessage(t, p.botID, &v1.SendMessageRequest{ChannelId: channelID, Text: text, ThreadRootId: threadID}, s.now())
			return err
		})
		if err == nil {
			s.pushMessage(p.botID, msg)
		}
	}
	if err != nil {
		s.log.Warn("plugin reply not sent", "plugin", p.name, "err", err)
	}
}

// pluginTick queues every timer that is due.
func (s *Server) pluginTick() {
	now := s.now()
	for _, p := range s.pluginList() {
		p.mu.Lock()
		for i := range p.timers {
			t := &p.timers[i]
			if now.Before(t.next) {
				continue
			}
			t.next = now.Add(t.every)
			s.queuePlugin(func() {
				if r, ok := s.callPlugin(p, fmt.Sprintf("__sb.timers[%d].fn", i)); ok {
					s.pluginSend(p, r, "", "")
				}
			})
		}
		p.mu.Unlock()
	}
}

// pluginLoop runs queued hook calls one at a time, so a slow plugin delays
// others by at most the time limit per call.
// ponytail: one worker for all plugins; one per plugin if busy communities need it.
func (s *Server) pluginLoop() {
	defer s.wg.Done()
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			for _, p := range s.pluginList() {
				p.mu.Lock()
				p.removed = true
				stopRuntime(p)
				p.mu.Unlock()
			}
			return
		case <-tick.C:
			s.pluginTick()
		case job := <-s.pluginJobs:
			job()
		}
	}
}

// stopRuntime closes the plugin's runtime. Closing a runtime that was killed
// mid-call panics inside qjs, so recover; the garbage collector frees the rest.
func stopRuntime(p *plugin) {
	if p.rt == nil {
		return
	}
	func() {
		defer func() { recover() }()
		p.rt.Close()
	}()
	p.cancel()
	p.rt = nil
}

// ---------------------------------------------------------------------------
// Plugin admin (BotService): list, install, enable and disable, delete.
// ---------------------------------------------------------------------------

const maxPluginSource = 256 << 10

// pluginName checks the caller is an admin and normalizes name.
func pluginName(ctx context.Context, name string) (string, error) {
	if !isAdmin(me(ctx)) {
		return "", errf(connect.CodePermissionDenied, "only admins can manage plugins")
	}
	name = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".js")
	if !usernameRE.MatchString(name) {
		return "", errf(connect.CodeInvalidArgument, "plugin names use 2 to 32 of a-z, 0-9, _, . and -")
	}
	return name, nil
}

// listPlugins reads the plugins folder: <name>.js is enabled,
// <name>.js.disabled is not. only, if set, picks one plugin.
func (s *Server) listPlugins(ctx context.Context, only string) ([]*v1.Plugin, error) {
	ents, err := os.ReadDir(s.pluginDir())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	s.pluginsMu.Lock()
	errs := maps.Clone(s.pluginErrs)
	s.pluginsMu.Unlock()
	running := map[string]*plugin{}
	for _, p := range s.pluginList() {
		running[p.name] = p
	}
	var out []*v1.Plugin
	for _, e := range ents {
		name, enabled := strings.CutSuffix(e.Name(), ".js")
		if !enabled {
			var ok bool
			if name, ok = strings.CutSuffix(e.Name(), ".js.disabled"); !ok {
				continue
			}
		}
		if only != "" && name != only {
			continue
		}
		pl := &v1.Plugin{Name: name, Enabled: enabled, Error: errs[name]}
		if p := running[name]; p != nil && enabled {
			p.mu.Lock()
			pl.Running, pl.Error, pl.BotId = true, p.err, p.botID
			p.mu.Unlock()
		} else if bot, err := s.loadMember(ctx, s.db.r, "username = ? AND kind = ? AND deleted = 0", name, v1.MemberKind_MEMBER_KIND_BOT); err == nil && bot != nil {
			pl.BotId = bot.Id
		}
		out = append(out, pl)
	}
	return out, nil
}

// onePlugin is the reply for a change: the plugin as it is now.
func (s *Server) onePlugin(ctx context.Context, name string) (*v1.Plugin, error) {
	if err := s.writeTx(ctx, func(t *wtx) error {
		return t.emit(&v1.Event{Kind: &v1.Event_PluginsChanged{PluginsChanged: true}}, "", "")
	}); err != nil {
		return nil, err
	}
	ps, err := s.listPlugins(ctx, name)
	if err != nil || len(ps) == 0 {
		return nil, err
	}
	return ps[0], nil
}

func (s *Server) ListPlugins(ctx context.Context, _ *connect.Request[v1.ListPluginsRequest]) (*connect.Response[v1.ListPluginsResponse], error) {
	if !isAdmin(me(ctx)) {
		return nil, errf(connect.CodePermissionDenied, "only admins can manage plugins")
	}
	ps, err := s.listPlugins(ctx, "")
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ListPluginsResponse{Plugins: ps}), nil
}

func (s *Server) InstallPlugin(ctx context.Context, req *connect.Request[v1.InstallPluginRequest]) (*connect.Response[v1.InstallPluginResponse], error) {
	name, err := pluginName(ctx, req.Msg.Name)
	if err != nil {
		return nil, err
	}
	src := req.Msg.Source
	if len(src) > maxPluginSource {
		return nil, errf(connect.CodeInvalidArgument, "plugin source is over %d KB", maxPluginSource>>10)
	}
	if strings.TrimSpace(src) == "" {
		return nil, errf(connect.CodeInvalidArgument, "plugin source is empty")
	}
	s.pluginOps.Lock()
	defer s.pluginOps.Unlock()
	p, err := s.preparePlugin(name, src)
	if err != nil {
		return nil, errf(connect.CodeInvalidArgument, "plugin did not load: %s", firstLine(err.Error()))
	}
	dir := s.pluginDir()
	err = os.MkdirAll(dir, 0o700)
	var f *os.File
	if err == nil {
		f, err = os.CreateTemp(dir, ".install-*")
	}
	if err == nil {
		_, err = f.WriteString(src)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			err = os.Rename(f.Name(), filepath.Join(dir, name+".js"))
		}
		if err != nil {
			os.Remove(f.Name())
		}
	}
	if err != nil {
		p.mu.Lock()
		stopRuntime(p)
		p.mu.Unlock()
		return nil, err
	}
	os.Remove(filepath.Join(dir, name+".js.disabled"))
	s.swapPlugin(name, p)
	s.log.Info("plugin installed", "plugin", name, "by", me(ctx).Id, "bytes", len(src))
	pl, err := s.onePlugin(ctx, name)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.InstallPluginResponse{Plugin: pl}), nil
}

func (s *Server) SetPluginEnabled(ctx context.Context, req *connect.Request[v1.SetPluginEnabledRequest]) (*connect.Response[v1.SetPluginEnabledResponse], error) {
	name, err := pluginName(ctx, req.Msg.Name)
	if err != nil {
		return nil, err
	}
	s.pluginOps.Lock()
	defer s.pluginOps.Unlock()
	on, off := filepath.Join(s.pluginDir(), name+".js"), filepath.Join(s.pluginDir(), name+".js.disabled")
	if !exists(on) && !exists(off) {
		return nil, errf(connect.CodeNotFound, "no plugin %q", name)
	}
	if req.Msg.Enabled {
		if !exists(on) {
			if err := os.Rename(off, on); err != nil {
				return nil, err
			}
		}
		s.loadPluginFile(name)
	} else {
		if exists(on) {
			if err := os.Rename(on, off); err != nil {
				return nil, err
			}
		}
		s.swapPlugin(name, nil)
	}
	s.log.Info("plugin enabled changed", "plugin", name, "enabled", req.Msg.Enabled, "by", me(ctx).Id)
	pl, err := s.onePlugin(ctx, name)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.SetPluginEnabledResponse{Plugin: pl}), nil
}

func (s *Server) DeletePlugin(ctx context.Context, req *connect.Request[v1.DeletePluginRequest]) (*connect.Response[v1.DeletePluginResponse], error) {
	name, err := pluginName(ctx, req.Msg.Name)
	if err != nil {
		return nil, err
	}
	s.pluginOps.Lock()
	defer s.pluginOps.Unlock()
	on, off := filepath.Join(s.pluginDir(), name+".js"), filepath.Join(s.pluginDir(), name+".js.disabled")
	if !exists(on) && !exists(off) {
		return nil, errf(connect.CodeNotFound, "no plugin %q", name)
	}
	for _, f := range []string{on, off} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	s.swapPlugin(name, nil)
	err = s.writeTx(ctx, func(t *wtx) error {
		bot, err := s.loadMember(ctx, t, "username = ? AND kind = ? AND deleted = 0", name, v1.MemberKind_MEMBER_KIND_BOT)
		if err != nil || bot == nil {
			return err
		}
		return deleteBot(t, bot.Id)
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("plugin deleted", "plugin", name, "by", me(ctx).Id)
	if _, err := s.onePlugin(ctx, name); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeletePluginResponse{}), nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
