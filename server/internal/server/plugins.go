package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
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

	mu     sync.Mutex
	rt       *qjs.Runtime
	cancel   context.CancelFunc
	timers   []pluginTimer
	question string // the plugin's joinQuestion, if any
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
	files, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "plugins", "*.js"))
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".js")
		src, err := os.ReadFile(f)
		if err == nil && !usernameRE.MatchString(name) {
			err = errors.New("file name must be a valid username (2 to 32 of a-z, 0-9, _, . and -)")
		}
		p := &plugin{name: name, src: string(src)}
		if err == nil {
			err = s.pluginBot(p)
		}
		if err == nil {
			p.mu.Lock()
			err = s.startPlugin(p)
			p.mu.Unlock()
		}
		if err != nil {
			s.log.Error("plugin not loaded", "plugin", name, "err", err)
			continue
		}
		s.log.Info("plugin loaded", "plugin", name, "bot", p.botID, "timers", len(p.timers))
		s.plugins = append(s.plugins, p)
	}
	s.wg.Add(1)
	go s.pluginLoop()
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
		MemoryLimit:        s.pluginMemory,
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
	timer := time.AfterFunc(s.pluginTimeout, p.cancel)
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
		dead, err = true, fmt.Errorf("took longer than %s", s.pluginTimeout)
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
	for _, p := range s.plugins {
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
	if len(answers) > len(s.plugins) {
		return errf(connect.CodeInvalidArgument, "too many answers")
	}
	for _, a := range answers {
		if err := checkText("answers", a, maxAnswerChars, false); err != nil {
			return err
		}
	}
	n := 0
	for _, p := range s.plugins {
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
	if len(s.plugins) == 0 || author.Kind == v1.MemberKind_MEMBER_KIND_BOT {
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
		for _, p := range s.plugins {
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
		err = s.writeTx(context.Background(), func(t *wtx) error {
			_, err := s.sendMessage(t, p.botID, &v1.SendMessageRequest{ChannelId: channelID, Text: text, ThreadRootId: threadID}, s.now())
			return err
		})
	}
	if err != nil {
		s.log.Warn("plugin reply not sent", "plugin", p.name, "err", err)
	}
}

// pluginTick queues every timer that is due.
func (s *Server) pluginTick() {
	now := s.now()
	for _, p := range s.plugins {
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
			for _, p := range s.plugins {
				p.mu.Lock()
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
