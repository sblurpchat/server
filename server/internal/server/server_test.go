package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "sblurp.chat/server/gen/sblurp/v1"
	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

// ---------------------------------------------------------------------------
// Harness: a real HTTP server, a fake issuer with a JWKS, a fake clock.
// ---------------------------------------------------------------------------

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type issuer struct {
	url string
	key ed25519.PrivateKey
	kid string
}

func newIssuer(t *testing.T) *issuer {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	is := &issuer{key: priv, kid: "k1"}
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": is.kid,
			"x": base64.RawURLEncoding.EncodeToString(pub),
		}}})
	}))
	t.Cleanup(hs.Close)
	is.url = hs.URL
	return is
}

func signJWT(key ed25519.PrivateKey, header, claims map[string]any) string {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	in := b64.EncodeToString(h) + "." + b64.EncodeToString(c)
	return in + "." + b64.EncodeToString(ed25519.Sign(key, []byte(in)))
}

type env struct {
	t      *testing.T
	s      *Server
	url    string
	clock  *fakeClock
	iss    *issuer
	dir    string
	cfgMod func(*Config)
}

func newEnv(t *testing.T, mods ...func(*Config)) *env {
	t.Helper()
	e := &env{t: t, clock: &fakeClock{t: time.Now().Truncate(time.Second)}, iss: newIssuer(t), dir: t.TempDir()}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e.url = "http://" + ln.Addr().String()
	cfg := Config{
		Name: "Test", BaseURL: e.url, TrustedIssuers: []string{e.iss.url}, DataDir: e.dir,
		Now: e.clock.Now, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, m := range mods {
		m(&cfg)
	}
	e.s, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	hs := &httptest.Server{Listener: ln, Config: &http.Server{Handler: e.s.Handler(), Protocols: new(http.Protocols)}}
	hs.Config.Protocols.SetHTTP1(true)
	hs.Config.Protocols.SetUnencryptedHTTP2(true)
	hs.Start()
	t.Cleanup(func() {
		e.s.DropSubscribers()
		hs.Close()
		e.s.Close()
	})
	return e
}

// claims returns valid claims for sub; tests tweak them.
func (e *env) claims(sub string) map[string]any {
	now := e.clock.Now().Unix()
	return map[string]any{"iss": e.iss.url, "sub": sub, "aud": e.url, "exp": now + 900, "iat": now,
		"jti": sub + "-jti", "preferred_username": sub}
}

func (e *env) token(sub string) string {
	return signJWT(e.iss.key, map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": e.iss.kid}, e.claims(sub))
}

type bearer struct{ tok string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if b.tok != "" {
		r.Header.Set("Authorization", "Bearer "+b.tok)
	}
	return http.DefaultTransport.RoundTrip(r)
}

type client struct {
	e     *env
	tok   string
	srv   sblurpv1connect.ServerServiceClient
	chat  sblurpv1connect.ChatServiceClient
	bots  sblurpv1connect.BotServiceClient
	me    *v1.Member
	httpc *http.Client
}

func (e *env) client(tok string) *client {
	hc := &http.Client{Transport: bearer{tok}}
	return &client{e: e, tok: tok, httpc: hc,
		srv:  sblurpv1connect.NewServerServiceClient(hc, e.url),
		chat: sblurpv1connect.NewChatServiceClient(hc, e.url),
		bots: sblurpv1connect.NewBotServiceClient(hc, e.url)}
}

// join logs in as sub and joins.
func (e *env) join(sub string) *client {
	e.t.Helper()
	c := e.client(e.token(sub))
	res, err := c.srv.Join(context.Background(), connect.NewRequest(&v1.JoinRequest{DisplayName: strings.ToUpper(sub[:1]) + sub[1:]}))
	if err != nil {
		e.t.Fatalf("join %s: %v", sub, err)
	}
	c.me = res.Msg.Member
	return c
}

func ctx() context.Context { return context.Background() }

// must unwraps a response. It panics on error, which fails the test with a
// stack trace.
func must[T any](res *connect.Response[T], err error) *T {
	if err != nil {
		panic(err)
	}
	return res.Msg
}

func wantCode(t *testing.T, err error, code connect.Code) {
	t.Helper()
	if connect.CodeOf(err) != code {
		t.Fatalf("got %v, want code %v", err, code)
	}
}

func (c *client) channel(name string, kind v1.ChannelKind) *v1.Channel {
	return must(c.chat.CreateChannel(ctx(), connect.NewRequest(&v1.CreateChannelRequest{Name: name, Kind: kind}))).Channel
}

func (c *client) send(channel, text string) *v1.Message {
	c.e.t.Helper()
	return must(c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: channel, Text: text}))).Message
}

func (c *client) state() *v1.GetStateResponse {
	return must(c.srv.GetState(ctx(), connect.NewRequest(&v1.GetStateRequest{})))
}

func readStateFor(st *v1.GetStateResponse, channel string) *v1.ReadState {
	for _, rs := range st.ReadStates {
		if rs.ChannelId == channel {
			return rs
		}
	}
	return nil
}

// subscription collects events from a Subscribe stream.
type subscription struct {
	t      *testing.T
	events chan *v1.Event
	cancel context.CancelFunc
	done   chan error
}

func (c *client) subscribe(after int64) *subscription {
	cx, cancel := context.WithCancel(ctx())
	stream, err := c.srv.Subscribe(cx, connect.NewRequest(&v1.SubscribeRequest{AfterSeq: after}))
	if err != nil {
		c.e.t.Fatal(err)
	}
	s := &subscription{t: c.e.t, events: make(chan *v1.Event, 10000), cancel: cancel, done: make(chan error, 1)}
	go func() {
		for stream.Receive() {
			s.events <- stream.Msg()
		}
		s.done <- stream.Err()
	}()
	c.e.t.Cleanup(cancel)
	return s
}

// next returns the next event matching ok, skipping presence and heartbeat.
// It collects every event it skipped in seen.
func (s *subscription) next(ok func(*v1.Event) bool, seen *[]*v1.Event) *v1.Event {
	s.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-s.events:
			if seen != nil {
				*seen = append(*seen, ev)
			}
			if ok(ev) {
				return ev
			}
		case err := <-s.done:
			s.t.Fatalf("stream ended: %v", err)
		case <-timeout:
			s.t.Fatal("timed out waiting for event")
		}
	}
}

func isCreated(text string) func(*v1.Event) bool {
	return func(ev *v1.Event) bool { return ev.GetMessageCreated().GetText() == text }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestAuth(t *testing.T) {
	e := newEnv(t)
	anon := e.client("")
	info := must(anon.srv.GetServerInfo(ctx(), connect.NewRequest(&v1.GetServerInfoRequest{})))
	if info.BaseUrl != e.url || info.ProtocolVersion != 1 || info.TrustedIssuers[0] != e.iss.url {
		t.Fatalf("info = %v", info)
	}
	_, err := anon.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)

	owner := e.join("ana")
	if owner.me.Role != v1.MemberRole_MEMBER_ROLE_OWNER || owner.me.Username != "ana" || owner.me.Kind != v1.MemberKind_MEMBER_KIND_HUMAN {
		t.Fatalf("first member = %v", owner.me)
	}
	again := must(owner.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{})))
	if again.Created || again.Member.Id != owner.me.Id {
		t.Fatalf("second join = %v", again)
	}
	if bob := e.join("bob"); bob.me.Role != v1.MemberRole_MEMBER_ROLE_MEMBER {
		t.Fatalf("second member role = %v", bob.me.Role)
	}

	// A valid token that has not joined may only call Join and GetServerInfo.
	stranger := e.client(e.token("carol"))
	_, err = stranger.srv.GetState(ctx(), connect.NewRequest(&v1.GetStateRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)

	hdr := map[string]any{"alg": "EdDSA", "kid": e.iss.kid}
	reject := func(name, tok string) {
		t.Helper()
		_, err := e.client(tok).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("%s: got %v, want unauthenticated", name, err)
		}
	}
	c := e.claims("dave")
	c["aud"] = "http://other.example"
	reject("wrong audience", signJWT(e.iss.key, hdr, c))

	other := newIssuer(t) // a real issuer, but not trusted
	c = e.claims("dave")
	c["iss"] = other.url
	reject("untrusted issuer", signJWT(other.key, hdr, c))

	_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
	reject("bad signature", signJWT(wrongKey, hdr, e.claims("dave")))

	good := e.token("dave")
	parts := strings.Split(good, ".")
	none := b64.EncodeToString([]byte(`{"alg":"none","kid":"k1"}`))
	reject("alg none", none+"."+parts[1]+".")
	reject("alg none with sig", none+"."+parts[1]+"."+parts[2])
	hs := b64.EncodeToString([]byte(`{"alg":"HS256","kid":"k1"}`))
	reject("alg HS256", hs+"."+parts[1]+"."+parts[2])
	// Validly signed by the trusted key, but not labelled EdDSA.
	for _, alg := range []string{"none", "HS256", "RS256", "eddsa"} {
		reject("signed with alg "+alg, signJWT(e.iss.key, map[string]any{"alg": alg, "kid": e.iss.kid}, e.claims("dave")))
	}
	reject("garbage", "not.a.jwt")

	c = e.claims("dave")
	c["aud"] = []string{"http://x", e.url}
	if _, err := e.client(signJWT(e.iss.key, hdr, c)).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{})); err != nil {
		t.Fatalf("aud list containing this server: %v", err)
	}

	c = e.claims("erin")
	c["iat"] = e.clock.Now().Add(10 * time.Minute).Unix()
	reject("issued in the future", signJWT(e.iss.key, hdr, c))

	tok := e.token("erin")
	e.clock.Advance(20 * time.Minute)
	reject("expired", tok)
}

func TestSubscribeLiveResumeAndResync(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.KeepEvents = 3 })
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)

	sub := bob.subscribe(bob.state().Seq)
	ana.send(gen.Id, "hello bob")
	ev := sub.next(isCreated("hello bob"), nil)
	if ev.Seq == 0 || ev.GetMessageCreated().AuthorId != ana.me.Id || ev.GetMessageCreated().Seq != ev.Seq {
		t.Fatalf("event = %v", ev)
	}
	last := ev.Seq
	sub.cancel()

	// Missed while disconnected, then replayed in order.
	for _, txt := range []string{"one", "two", "three"} {
		ana.send(gen.Id, txt)
	}
	sub = bob.subscribe(last)
	var got []string
	for range 3 {
		got = append(got, sub.next(func(ev *v1.Event) bool { return ev.GetMessageCreated() != nil }, nil).GetMessageCreated().Text)
	}
	if strings.Join(got, ",") != "one,two,three" {
		t.Fatalf("replay = %v", got)
	}
	// Live continues on the same stream without duplicates.
	ana.send(gen.Id, "four")
	if ev := sub.next(func(ev *v1.Event) bool { return ev.GetMessageCreated() != nil }, nil); ev.GetMessageCreated().Text != "four" {
		t.Fatalf("after replay got %v", ev)
	}
	sub.cancel()

	// Prune keeps the newest 3 or the last 7 days. Move 8 days ahead.
	e.clock.Advance(8 * 24 * time.Hour)
	if err := e.s.prune(ctx()); err != nil {
		t.Fatal(err)
	}
	bob, ana = e.client(e.token("bob")), e.client(e.token("ana")) // old tokens expired
	old := bob.subscribe(last)
	if ev := old.next(func(ev *v1.Event) bool { return !ev.GetHeartbeat() }, nil); !ev.GetResync() {
		t.Fatalf("too-old seq got %v, want resync", ev)
	}
	ahead := bob.subscribe(bob.state().Seq + 100)
	if ev := ahead.next(func(ev *v1.Event) bool { return !ev.GetHeartbeat() }, nil); !ev.GetResync() {
		t.Fatalf("future seq got %v, want resync", ev)
	}
	current := bob.subscribe(bob.state().Seq)
	ana.send(gen.Id, "fresh")
	if ev := current.next(func(ev *v1.Event) bool { return ev.GetResync() || ev.GetMessageCreated() != nil }, nil); ev.GetResync() {
		t.Fatal("current seq must not resync")
	}
}

func TestPrivateChannelAndDMVisibility(t *testing.T) {
	e := newEnv(t)
	ana, bob, eve := e.join("ana"), e.join("bob"), e.join("eve")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	start := eve.state().Seq
	eveSub := eve.subscribe(start)
	bobSub := bob.subscribe(start)

	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	ana.send(secret.Id, "private plans")
	dm := must(ana.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{bob.me.Id}}))).Channel
	if dm.Kind != v1.ChannelKind_CHANNEL_KIND_DM || len(dm.MemberIds) != 2 {
		t.Fatalf("dm = %v", dm)
	}
	again := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{ana.me.Id}}))).Channel
	if again.Id != dm.Id {
		t.Fatal("OpenDM with the same members must return the same DM")
	}
	ana.send(dm.Id, "psst bob")
	bobSub.next(isCreated("psst bob"), nil)
	ana.send(gen.Id, "marker")

	leaked := func(evs []*v1.Event) {
		t.Helper()
		for _, ev := range evs {
			id := ev.GetMessageCreated().GetChannelId() + ev.GetChannelCreated().GetId()
			if id == secret.Id || id == dm.Id {
				t.Fatalf("eve received %v", ev)
			}
		}
	}
	var seen []*v1.Event
	eveSub.next(isCreated("marker"), &seen)
	leaked(seen)
	// Replay applies the same filter.
	seen = nil
	eve.subscribe(start).next(isCreated("marker"), &seen)
	leaked(seen)

	for _, c := range eve.state().Channels {
		if c.Id == secret.Id || c.Id == dm.Id {
			t.Fatalf("eve's state lists %v", c)
		}
	}
	_, err := eve.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: secret.Id}))
	wantCode(t, err, connect.CodeNotFound)
	_, err = eve.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: dm.Id, Text: "hi"}))
	wantCode(t, err, connect.CodeNotFound)
	if res := must(eve.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "plans"}))); len(res.Messages) != 0 {
		t.Fatalf("eve found %v", res.Messages)
	}
	if res := must(ana.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "plan"}))); len(res.Messages) != 1 {
		t.Fatalf("ana prefix search found %v", res.Messages)
	}
}

func (c *client) setRole(id string, role v1.MemberRole) error {
	_, err := c.srv.SetMemberRole(ctx(), connect.NewRequest(&v1.SetMemberRoleRequest{MemberId: id, Role: role}))
	return err
}

func (c *client) addTo(channel string, ids ...string) error {
	_, err := c.chat.AddChannelMembers(ctx(), connect.NewRequest(&v1.AddChannelMembersRequest{ChannelId: channel, MemberIds: ids}))
	return err
}

func (c *client) removeFrom(channel, id string) error {
	_, err := c.chat.RemoveChannelMember(ctx(), connect.NewRequest(&v1.RemoveChannelMemberRequest{ChannelId: channel, MemberId: id}))
	return err
}

func (c *client) inState(channel string) bool {
	for _, ch := range c.state().Channels {
		if ch.Id == channel {
			return true
		}
	}
	return false
}

func TestRolesAndPrivateChannelMembers(t *testing.T) {
	e := newEnv(t)
	ana, bob, cy, dee := e.join("ana"), e.join("bob"), e.join("cy"), e.join("dee") // ana is the owner
	const (
		member = v1.MemberRole_MEMBER_ROLE_MEMBER
		mod    = v1.MemberRole_MEMBER_ROLE_MODERATOR
		admin  = v1.MemberRole_MEMBER_ROLE_ADMIN
	)
	wantCode(t, bob.setRole(cy.me.Id, mod), connect.CodePermissionDenied) // members set no roles
	sub := cy.subscribe(cy.state().Seq)
	if err := ana.setRole(bob.me.Id, admin); err != nil {
		t.Fatal(err)
	}
	if ev := sub.next(func(ev *v1.Event) bool { return ev.GetMemberUpdated() != nil }, nil); ev.GetMemberUpdated().Role != admin {
		t.Fatalf("member_updated = %v", ev)
	}
	if err := bob.setRole(cy.me.Id, mod); err != nil {
		t.Fatal(err)
	}
	wantCode(t, bob.setRole(dee.me.Id, admin), connect.CodePermissionDenied)  // not up to your own rank
	wantCode(t, bob.setRole(ana.me.Id, member), connect.CodePermissionDenied) // not on a higher rank
	wantCode(t, cy.setRole(dee.me.Id, mod), connect.CodePermissionDenied)     // moderators are not admins
	wantCode(t, ana.setRole(bob.me.Id, v1.MemberRole_MEMBER_ROLE_OWNER), connect.CodeInvalidArgument)

	// Private channel members.
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	ana.send(secret.Id, "old news")
	wantCode(t, ana.addTo(gen.Id, cy.me.Id), connect.CodeInvalidArgument)
	wantCode(t, bob.addTo(secret.Id, bob.me.Id), connect.CodeNotFound) // bob cannot see it
	wantCode(t, ana.addTo(secret.Id, "nobody"), connect.CodeNotFound)
	if err := ana.addTo(secret.Id, cy.me.Id); err != nil {
		t.Fatal(err)
	}
	if ev := sub.next(func(ev *v1.Event) bool { return ev.GetChannelUpdated() != nil }, nil); len(ev.GetChannelUpdated().MemberIds) != 2 {
		t.Fatalf("channel_updated = %v", ev)
	}
	if rs := readStateFor(cy.state(), secret.Id); rs == nil || rs.UnreadCount != 0 {
		t.Fatalf("cy's read state = %v", rs)
	}
	if err := cy.addTo(secret.Id, dee.me.Id); err != nil { // any channel member may add
		t.Fatal(err)
	}
	deeSub := dee.subscribe(dee.state().Seq)
	wantCode(t, dee.removeFrom(secret.Id, cy.me.Id), connect.CodePermissionDenied)
	wantCode(t, cy.removeFrom(secret.Id, ana.me.Id), connect.CodePermissionDenied)
	if err := cy.removeFrom(secret.Id, dee.me.Id); err != nil {
		t.Fatal(err)
	}
	if ev := deeSub.next(func(ev *v1.Event) bool { return ev.GetChannelDeleted() != "" }, nil); ev.GetChannelDeleted() != secret.Id {
		t.Fatalf("dee got %v", ev)
	}
	if dee.inState(secret.Id) {
		t.Fatal("dee still sees the channel")
	}
	if err := cy.removeFrom(secret.Id, cy.me.Id); err != nil { // leave
		t.Fatal(err)
	}
	if cy.inState(secret.Id) || !ana.inState(secret.Id) {
		t.Fatal("cy left, ana stays")
	}
}

func TestLeaveKickAndBan(t *testing.T) {
	e := newEnv(t)
	ana, bob, cy, dee := e.join("ana"), e.join("bob"), e.join("cy"), e.join("dee") // ana is the owner
	must(ana.srv.SetMemberRole(ctx(), connect.NewRequest(&v1.SetMemberRoleRequest{MemberId: bob.me.Id, Role: v1.MemberRole_MEMBER_ROLE_ADMIN})))
	must(ana.srv.SetMemberRole(ctx(), connect.NewRequest(&v1.SetMemberRoleRequest{MemberId: cy.me.Id, Role: v1.MemberRole_MEMBER_ROLE_MODERATOR})))
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	if err := ana.addTo(secret.Id, dee.me.Id); err != nil {
		t.Fatal(err)
	}
	kick := func(c *client, id string) error {
		_, err := c.srv.KickMember(ctx(), connect.NewRequest(&v1.KickMemberRequest{MemberId: id}))
		return err
	}
	ban := func(c *client, id string) error {
		_, err := c.srv.BanMember(ctx(), connect.NewRequest(&v1.BanMemberRequest{MemberId: id}))
		return err
	}
	wantCode(t, kick(dee, cy.me.Id), connect.CodePermissionDenied) // member on moderator
	wantCode(t, kick(cy, bob.me.Id), connect.CodePermissionDenied) // moderator on admin
	wantCode(t, ban(bob, ana.me.Id), connect.CodePermissionDenied) // admin on owner
	bot := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"}))).Bot
	wantCode(t, kick(ana, bot.Id), connect.CodeInvalidArgument)

	// Kick: dee's stream ends, her token stops working, the others see
	// member_left and she leaves the private channel. She may come back.
	anaSub := ana.subscribe(ana.state().Seq)
	deeSub := dee.subscribe(dee.state().Seq)
	if err := kick(cy, dee.me.Id); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-deeSub.done:
		if err == nil {
			t.Fatal("dee's stream ended without an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dee's stream stayed open")
	}
	if ev := anaSub.next(func(ev *v1.Event) bool { return ev.GetMemberLeft() != "" }, nil); ev.GetMemberLeft() != dee.me.Id {
		t.Fatalf("member_left = %v", ev)
	}
	_, err := dee.srv.GetState(ctx(), connect.NewRequest(&v1.GetStateRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)
	stream, _ := dee.srv.Subscribe(ctx(), connect.NewRequest(&v1.SubscribeRequest{}))
	for stream.Receive() {
	}
	wantCode(t, stream.Err(), connect.CodePermissionDenied)
	for _, m := range ana.state().Members {
		if m.Id == dee.me.Id {
			t.Fatal("dee is still listed")
		}
	}
	for _, c := range ana.state().Channels {
		if c.Id == secret.Id && len(c.MemberIds) != 1 {
			t.Fatalf("secret members = %v", c.MemberIds)
		}
	}
	back := must(dee.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{DisplayName: "Dee"})))
	if !back.Created || back.Member.Id != dee.me.Id || back.Member.Role != v1.MemberRole_MEMBER_ROLE_MEMBER {
		t.Fatalf("rejoin = %v", back)
	}
	if dee.inState(secret.Id) {
		t.Fatal("a rejoin restored a private channel")
	}

	// Ban: she cannot come back.
	if err := ban(bob, dee.me.Id); err != nil {
		t.Fatal(err)
	}
	_, err = dee.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{DisplayName: "Dee"}))
	wantCode(t, err, connect.CodePermissionDenied)

	// Leave: anyone but the owner.
	_, err = ana.srv.LeaveCommunity(ctx(), connect.NewRequest(&v1.LeaveCommunityRequest{}))
	wantCode(t, err, connect.CodeFailedPrecondition)
	must(cy.srv.LeaveCommunity(ctx(), connect.NewRequest(&v1.LeaveCommunityRequest{})))
	_, err = cy.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)
	if again := must(cy.srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{DisplayName: "Cy"}))); again.Member.Role != v1.MemberRole_MEMBER_ROLE_MEMBER {
		t.Fatalf("cy rejoined as %v", again.Member.Role)
	}
}

func TestUnreadAndMentions(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	other := bob.subscribe(bob.state().Seq) // bob's "other device"

	root := ana.send(gen.Id, "morning all")
	ana.send(gen.Id, "hey <@"+bob.me.Id+"> did you see this?")
	ana.send(gen.Id, "<@someone-else> not you")
	must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{
		ChannelId: gen.Id, ThreadRootId: root.Id, Text: "thread ping <@" + bob.me.Id + ">"})))
	bob.send(gen.Id, "my own message never counts <@"+bob.me.Id+">")

	rs := readStateFor(bob.state(), gen.Id)
	if rs.UnreadCount != 3 || rs.MentionCount != 2 {
		t.Fatalf("bob read state = %v, want 3 unread, 2 mentions", rs)
	}
	dm := must(ana.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{bob.me.Id}}))).Channel
	ana.send(dm.Id, "no mention needed in a DM")
	if rs := readStateFor(bob.state(), dm.Id); rs.UnreadCount != 1 || rs.MentionCount != 1 {
		t.Fatalf("dm read state = %v", rs)
	}

	marked := must(bob.chat.MarkRead(ctx(), connect.NewRequest(&v1.MarkReadRequest{ChannelId: gen.Id}))).ReadState
	if marked.UnreadCount != 0 || marked.MentionCount != 0 {
		t.Fatalf("after MarkRead = %v", marked)
	}
	ev := other.next(func(ev *v1.Event) bool { return ev.GetReadState() != nil }, nil)
	if ev.GetReadState().ChannelId != gen.Id || ev.GetReadState().LastReadSeq != marked.LastReadSeq || ev.Seq == 0 {
		t.Fatalf("read_state event = %v", ev)
	}
	ana.send(gen.Id, "after read")
	if rs := readStateFor(bob.state(), gen.Id); rs.UnreadCount != 1 {
		t.Fatalf("after new message = %v", rs)
	}
	// Ana must not get bob's read state.
	var seen []*v1.Event
	anaSub := ana.subscribe(marked.LastReadSeq - 1)
	ana.send(gen.Id, "marker")
	anaSub.next(isCreated("marker"), &seen)
	for _, ev := range seen {
		if ev.GetReadState() != nil {
			t.Fatalf("ana got bob's read state %v", ev)
		}
	}
}

func TestThreadsAndReactions(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	root := ana.send(gen.Id, "what should we build next?")
	e.clock.Advance(time.Minute)
	reply := must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{
		ChannelId: gen.Id, ThreadRootId: root.Id, Text: "threads!"}))).Message
	_, err := bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: reply.Id, Text: "nested"}))
	wantCode(t, err, connect.CodeInvalidArgument)

	top := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id}))).Messages
	if len(top) != 1 || top[0].ReplyCount != 1 || top[0].LastReplyAtMs != e.clock.Now().UnixMilli() {
		t.Fatalf("top level = %v", top)
	}
	thread := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id, ThreadRootId: root.Id}))).Messages
	if len(thread) != 1 || thread[0].Id != reply.Id {
		t.Fatalf("thread = %v", thread)
	}

	react := func(c *client, emoji string, remove bool) *v1.Message {
		return must(c.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: root.Id, Emoji: emoji, Remove: remove}))).Message
	}
	react(ana, "🎉", false)
	m := react(bob, "🎉", false)
	m = react(bob, "🎉", false) // twice is a no-op
	if len(m.Reactions) != 1 || len(m.Reactions[0].MemberIds) != 2 {
		t.Fatalf("reactions = %v", m.Reactions)
	}
	m = react(ana, "🎉", true)
	if len(m.Reactions) != 1 || m.Reactions[0].MemberIds[0] != bob.me.Id {
		t.Fatalf("after remove = %v", m.Reactions)
	}
	_, err = ana.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: root.Id, Emoji: "a b"}))
	wantCode(t, err, connect.CodeInvalidArgument)

	// Paging: before_id pages backwards, oldest first, with has_more.
	for i := range 5 {
		ana.send(gen.Id, fmt.Sprint("page ", i))
	}
	page := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id, Limit: 2})))
	if !page.HasMore || page.Messages[0].Text != "page 3" || page.Messages[1].Text != "page 4" {
		t.Fatalf("page = %v", page)
	}
	page = must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id, BeforeId: page.Messages[0].Id, Limit: 10})))
	if page.HasMore || len(page.Messages) != 4 || page.Messages[0].Id != root.Id {
		t.Fatalf("second page = %v", page)
	}
}

func TestEditAndDeletePermissions(t *testing.T) {
	e := newEnv(t)
	ana, bob, cy := e.join("ana"), e.join("bob"), e.join("cy") // ana is the owner
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	msg := bob.send(gen.Id, "tpyo")

	_, err := cy.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: msg.Id, Text: "hacked"}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = ana.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: msg.Id, Text: "owner edit"}))
	wantCode(t, err, connect.CodePermissionDenied) // nobody edits someone else's words

	e.clock.Advance(time.Second)
	edited := must(bob.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: msg.Id, Text: "typo"}))).Message
	if edited.Text != "typo" || edited.EditedAtMs != e.clock.Now().UnixMilli() || edited.Seq <= msg.Seq {
		t.Fatalf("edited = %v", edited)
	}
	// created_seq stays the seq of message_created (ticket 0303).
	listed := must(bob.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id}))).Messages
	if msg.CreatedSeq == 0 || msg.CreatedSeq != msg.Seq || edited.CreatedSeq != msg.CreatedSeq || listed[0].CreatedSeq != msg.CreatedSeq {
		t.Fatalf("created_seq: sent %d/%d, edited %d, listed %d", msg.Seq, msg.CreatedSeq, edited.CreatedSeq, listed[0].CreatedSeq)
	}

	_, err = cy.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: msg.Id}))
	wantCode(t, err, connect.CodePermissionDenied)
	own := cy.send(gen.Id, "mine")
	must(cy.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: own.Id})))
	// Owners (and admins and moderators) may delete anything.
	sub := bob.subscribe(bob.state().Seq)
	must(ana.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: msg.Id})))
	ev := sub.next(func(ev *v1.Event) bool { return ev.GetMessageDeleted() != nil }, nil)
	if ev.GetMessageDeleted().Id != msg.Id || ev.GetMessageDeleted().Text != "" || ev.GetMessageDeleted().CreatedSeq != msg.CreatedSeq {
		t.Fatalf("deleted event = %v", ev)
	}
	if left := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id}))).Messages; len(left) != 0 {
		t.Fatalf("deleted messages listed: %v", left)
	}
	_, err = bob.chat.EditMessage(ctx(), connect.NewRequest(&v1.EditMessageRequest{MessageId: msg.Id, Text: "back"}))
	wantCode(t, err, connect.CodeNotFound)
	if res := must(ana.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "typo"}))); len(res.Messages) != 0 {
		t.Fatal("deleted message is still searchable")
	}

	// Only admins create and update channels.
	_, err = bob.chat.CreateChannel(ctx(), connect.NewRequest(&v1.CreateChannelRequest{Name: "mine"}))
	wantCode(t, err, connect.CodePermissionDenied)
	topic := "new topic"
	_, err = bob.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: gen.Id, Topic: &topic}))
	wantCode(t, err, connect.CodePermissionDenied)
	upd := must(ana.chat.UpdateChannel(ctx(), connect.NewRequest(&v1.UpdateChannelRequest{ChannelId: gen.Id, Topic: &topic}))).Channel
	if upd.Topic != topic || upd.Name != "general" {
		t.Fatalf("updated = %v", upd)
	}
	_, err = ana.chat.CreateChannel(ctx(), connect.NewRequest(&v1.CreateChannelRequest{Name: "General"}))
	wantCode(t, err, connect.CodeAlreadyExists)
}

func TestBots(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	_, err := bob.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "nope"}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "Bad Name"}))
	wantCode(t, err, connect.CodeInvalidArgument)

	created := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "helper", DisplayName: "Helper"})))
	if !strings.HasPrefix(created.Token, "sbb_") || created.Bot.Kind != v1.MemberKind_MEMBER_KIND_BOT {
		t.Fatalf("created = %v", created.Bot)
	}
	var stored string
	e.s.db.r.QueryRow("SELECT token_hash FROM members WHERE id = ?", created.Bot.Id).Scan(&stored)
	if stored == "" || strings.Contains(stored, created.Token[4:]) {
		t.Fatal("token must be stored only as a hash")
	}
	bot := e.client(created.Token)
	if me := must(bot.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))).Member; me.Id != created.Bot.Id {
		t.Fatalf("bot me = %v", me)
	}
	sub := bob.subscribe(bob.state().Seq)
	bot.send(gen.Id, "beep")
	if ev := sub.next(isCreated("beep"), nil); ev.GetMessageCreated().AuthorId != created.Bot.Id {
		t.Fatal("wrong author")
	}
	if bots := must(bob.bots.ListBots(ctx(), connect.NewRequest(&v1.ListBotsRequest{}))).Bots; len(bots) != 1 {
		t.Fatalf("bots = %v", bots)
	}

	rotated := must(ana.bots.RotateBotToken(ctx(), connect.NewRequest(&v1.RotateBotTokenRequest{BotId: created.Bot.Id})))
	_, err = bot.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)
	bot = e.client(rotated.Token)
	must(bot.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{})))
	_, err = bot.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "spawn"}))
	wantCode(t, err, connect.CodePermissionDenied)

	must(ana.bots.DeleteBot(ctx(), connect.NewRequest(&v1.DeleteBotRequest{BotId: created.Bot.Id})))
	_, err = bot.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)
	_, err = e.client("sbb_made-up").srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)
}

func TestSendValidationIdempotencyAndRateLimit(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	req := &v1.SendMessageRequest{ChannelId: gen.Id, Text: "once", ClientId: "c-1"}
	a := must(ana.chat.SendMessage(ctx(), connect.NewRequest(req))).Message
	b := must(ana.chat.SendMessage(ctx(), connect.NewRequest(req))).Message
	if a.Id != b.Id || b.ClientId != "c-1" {
		t.Fatalf("retry made a new message: %v vs %v", a.Id, b.Id)
	}
	if n := len(must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id}))).Messages); n != 1 {
		t.Fatalf("%d messages, want 1", n)
	}

	for name, text := range map[string]string{"empty": "  ", "too long": strings.Repeat("é", 8001)} {
		_, err := ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: text}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
	must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: strings.Repeat("é", 8000)})))
	_, err := ana.chat.CreateChannel(ctx(), connect.NewRequest(&v1.CreateChannelRequest{Name: strings.Repeat("x", 81)}))
	wantCode(t, err, connect.CodeInvalidArgument)
	long := strings.Repeat("n", 81)
	_, err = ana.srv.UpdateProfile(ctx(), connect.NewRequest(&v1.UpdateProfileRequest{DisplayName: &long}))
	wantCode(t, err, connect.CodeInvalidArgument)

	// Burst of 10 (the burst above used up some), then 5 per second.
	e.clock.Advance(time.Minute)
	sent := 0
	for ; sent < 20; sent++ {
		if _, err := ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: "spam"})); err != nil {
			wantCode(t, err, connect.CodeResourceExhausted)
			break
		}
	}
	if sent != 10 {
		t.Fatalf("burst allowed %d, want 10", sent)
	}
	e.clock.Advance(time.Second)
	for i := range 5 {
		if _, err := ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: "refill"})); err != nil {
			t.Fatalf("message %d after 1s: %v", i, err)
		}
	}
	_, err = ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: "one too many"}))
	wantCode(t, err, connect.CodeResourceExhausted)
}

func TestListMessagesAroundAndAfter(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	other := ana.channel("other", v1.ChannelKind_CHANNEL_KIND_TEXT)
	var ids []string
	for i := range 10 {
		e.clock.Advance(time.Second) // rate limit
		ids = append(ids, ana.send(gen.Id, fmt.Sprint("m", i)).Id)
	}
	reply := must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: ids[2], Text: "r"}))).Message
	list := func(r *v1.ListMessagesRequest) (string, bool, bool) {
		r.ChannelId = gen.Id
		res := must(ana.chat.ListMessages(ctx(), connect.NewRequest(r)))
		var texts []string
		for _, m := range res.Messages {
			texts = append(texts, m.Text)
		}
		return strings.Join(texts, ","), res.HasMore, res.HasMoreAfter
	}
	for _, c := range []struct {
		req         *v1.ListMessagesRequest
		want        string
		more, after bool
	}{
		{&v1.ListMessagesRequest{AroundId: ids[5], Limit: 4}, "m3,m4,m5,m6", true, true},
		{&v1.ListMessagesRequest{AroundId: ids[9], Limit: 4}, "m7,m8,m9", true, false},
		{&v1.ListMessagesRequest{AroundId: ids[0], Limit: 4}, "m0,m1,m2,m3", false, true},
		{&v1.ListMessagesRequest{AfterId: ids[6], Limit: 5}, "m7,m8,m9", false, false},
		{&v1.ListMessagesRequest{AfterId: ids[2], Limit: 2}, "m3,m4", false, true},
		{&v1.ListMessagesRequest{BeforeId: ids[2], Limit: 5}, "m0,m1", false, false},
		{&v1.ListMessagesRequest{Limit: 3}, "m7,m8,m9", true, false},
		{&v1.ListMessagesRequest{AroundId: reply.Id, ThreadRootId: ids[2]}, "r", false, false},
	} {
		got, more, after := list(c.req)
		if got != c.want || more != c.more || after != c.after {
			t.Errorf("%v: got %s more=%v after=%v, want %s %v %v", c.req, got, more, after, c.want, c.more, c.after)
		}
	}
	for _, r := range []*v1.ListMessagesRequest{
		{ChannelId: gen.Id, AroundId: ids[1], BeforeId: ids[5]},
		{ChannelId: other.Id, AroundId: ids[1]},
		{ChannelId: gen.Id, AroundId: reply.Id}, // a reply needs its thread_root_id
	} {
		_, err := ana.chat.ListMessages(ctx(), connect.NewRequest(r))
		wantCode(t, err, connect.CodeInvalidArgument)
	}
}

func pngBytes(w, h int) []byte {
	var buf bytes.Buffer
	png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)))
	return buf.Bytes()
}

func (c *client) upload(name string, body []byte) (*http.Response, *v1.Attachment) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	fw.Write(body)
	mw.Close()
	req, _ := http.NewRequest("POST", c.e.url+"/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := c.httpc.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		return res, nil
	}
	a := &v1.Attachment{}
	if err := protojson.Unmarshal(data, a); err != nil {
		c.e.t.Fatal(err)
	}
	return res, a
}

func TestUpload(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	img := pngBytes(3, 2)
	_, a := ana.upload("../../cat.png", img)
	if a == nil || a.ContentType != "image/png" || a.Width != 3 || a.Height != 2 || a.Size != int64(len(img)) || a.Name != "cat.png" {
		t.Fatalf("attachment = %v", a)
	}
	if !strings.HasPrefix(a.Url, "/files/"+a.Id+"/cat.png?exp=") {
		t.Fatalf("url = %q", a.Url)
	}

	_, err := bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, AttachmentIds: []string{a.Id}}))
	wantCode(t, err, connect.CodeInvalidArgument) // not bob's upload
	msg := must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, AttachmentIds: []string{a.Id}}))).Message
	if len(msg.Attachments) != 1 || msg.Attachments[0].Id != a.Id {
		t.Fatalf("message attachments = %v", msg.Attachments)
	}
	_, err = ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, AttachmentIds: []string{a.Id}}))
	wantCode(t, err, connect.CodeInvalidArgument) // already used

	res, err := http.Get(e.url + a.Url)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(got, img) || res.Header.Get("Content-Type") != "image/png" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("GET file: %d bytes, headers %v", len(got), res.Header)
	}

	// HTML is sniffed, never served inline.
	_, h := ana.upload("x.png", []byte("<html><script>alert(1)</script></html>"))
	res, _ = http.Get(e.url + h.Url)
	res.Body.Close()
	if h.ContentType != "text/html; charset=utf-8" || !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") ||
		!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("html upload served as %q / %q", h.ContentType, res.Header.Get("Content-Disposition"))
	}

	if res, _ := e.client(e.token("stranger")).upload("a.txt", []byte("hi")); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member upload: %d", res.StatusCode)
	}
	if res, _ := e.client("").upload("a.txt", []byte("hi")); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous upload: %d", res.StatusCode)
	}
	if res, _ := ana.upload("big.bin", make([]byte, maxUpload+1)); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize upload: %d", res.StatusCode)
	}

	// Deleting the message removes the file.
	must(ana.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: msg.Id})))
	if res, _ := http.Get(e.url + a.Url); res.StatusCode != http.StatusNotFound {
		t.Fatalf("file of deleted message: %d", res.StatusCode)
	}
}

func getStatus(t *testing.T, url string) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestFileURLsAreSigned(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	_, a := ana.upload("a.png", pngBytes(1, 1))
	_, b := ana.upload("b.png", pngBytes(1, 1))
	sub := ana.subscribe(ana.state().Seq)
	must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: secret.Id, Text: "pic", AttachmentIds: []string{a.Id}})))

	plain := e.url + "/files/" + a.Id + "/a.png"
	if got := getStatus(t, plain); got != http.StatusForbidden {
		t.Fatalf("unsigned GET = %d", got)
	}
	// A signature for one file does not open another.
	_, query, _ := strings.Cut(b.Url, "?")
	if got := getStatus(t, plain+"?"+query); got != http.StatusForbidden {
		t.Fatalf("GET with another file's sig = %d", got)
	}
	exp, _ := strconv.ParseInt(strings.TrimPrefix(strings.Split(query, "&")[0], "exp="), 10, 64)
	if got := getStatus(t, plain+"?exp="+strconv.FormatInt(exp+3600, 10)+"&sig="+strings.Split(query, "&sig=")[1]); got != http.StatusForbidden {
		t.Fatalf("GET with a changed exp = %d", got)
	}

	// The live event, the list and the search all carry a working URL.
	ev := sub.next(isCreated("pic"), nil)
	listed := must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: secret.Id}))).Messages
	found := must(ana.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "pic"}))).Messages
	for name, m := range map[string]*v1.Message{"event": ev.GetMessageCreated(), "list": listed[0], "search": found[0]} {
		if got := getStatus(t, e.url+m.Attachments[0].Url); got != http.StatusOK {
			t.Fatalf("%s url %q = %d", name, m.Attachments[0].Url, got)
		}
	}
	// Replay signs too.
	replayed := ana.subscribe(0).next(isCreated("pic"), nil).GetMessageCreated().Attachments[0].Url
	if getStatus(t, e.url+replayed) != http.StatusOK {
		t.Fatalf("replayed url %q", replayed)
	}

	// Bob is not in the channel, so he never gets a signed URL.
	if len(must(bob.chat.Search(ctx(), connect.NewRequest(&v1.SearchRequest{Query: "pic"}))).Messages) != 0 {
		t.Fatal("bob found a private message")
	}

	// URLs expire after one to two hours.
	url := e.url + listed[0].Attachments[0].Url
	e.clock.Advance(59 * time.Minute)
	if got := getStatus(t, url); got != http.StatusOK {
		t.Fatalf("after 59m = %d", got)
	}
	e.clock.Advance(2 * time.Hour)
	if got := getStatus(t, url); got != http.StatusForbidden {
		t.Fatalf("after 3h = %d", got)
	}
}

func TestPresenceTypingHeartbeat(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.Heartbeat = 20 * time.Millisecond })
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	anaSub := ana.subscribe(ana.state().Seq)
	for range 3 { // the first is immediate, the rest come from the ticker
		anaSub.next(func(ev *v1.Event) bool { return ev.GetHeartbeat() }, nil)
	}

	bobSub := bob.subscribe(bob.state().Seq)
	on := anaSub.next(func(ev *v1.Event) bool { return ev.GetPresence().GetMemberId() == bob.me.Id }, nil)
	if on.GetPresence().Presence != v1.Presence_PRESENCE_ONLINE || on.Seq != 0 {
		t.Fatalf("presence = %v", on)
	}
	for _, m := range ana.state().Members {
		if m.Id == bob.me.Id && m.Presence != v1.Presence_PRESENCE_ONLINE {
			t.Fatal("bob should be online in state")
		}
	}
	must(bob.chat.SetTyping(ctx(), connect.NewRequest(&v1.SetTypingRequest{ChannelId: gen.Id})))
	if ev := anaSub.next(func(ev *v1.Event) bool { return ev.GetTyping() != nil }, nil); ev.GetTyping().MemberId != bob.me.Id || ev.Seq != 0 {
		t.Fatalf("typing = %v", ev)
	}
	bobSub.cancel()
	off := anaSub.next(func(ev *v1.Event) bool { return ev.GetPresence().GetMemberId() == bob.me.Id }, nil)
	if off.GetPresence().Presence != v1.Presence_PRESENCE_OFFLINE {
		t.Fatalf("presence after disconnect = %v", off)
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	h := newHub(func() int64 { return 0 })
	slow := h.add("m1")
	for range subBuffer + 1 {
		h.publish(&v1.Event{Seq: 1}, nil) // never blocks
	}
	select {
	case <-slow.gone:
	default:
		t.Fatal("slow subscriber was not dropped")
	}
	if h.isOnline("m1") {
		t.Fatal("dropped subscriber still counts as online")
	}
}

func TestCORSAndH2C(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("OPTIONS", e.url+sblurpv1connect.ChatServiceSendMessageProcedure, nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type,connect-protocol-version")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	h := res.Header
	if res.StatusCode != http.StatusNoContent || h.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(h.Get("Access-Control-Allow-Headers"), "Authorization") ||
		!strings.Contains(h.Get("Access-Control-Allow-Headers"), "Connect-Protocol-Version") {
		t.Fatalf("preflight: %d %v", res.StatusCode, h)
	}
	if !strings.Contains(h.Get("Access-Control-Expose-Headers"), "Grpc-Status") {
		t.Fatalf("expose headers: %v", h)
	}

	// gRPC over cleartext HTTP/2.
	tr := &http.Transport{Protocols: new(http.Protocols)}
	tr.Protocols.SetUnencryptedHTTP2(true)
	c := sblurpv1connect.NewServerServiceClient(&http.Client{Transport: tr}, e.url, connect.WithGRPC())
	info := must(c.GetServerInfo(ctx(), connect.NewRequest(&v1.GetServerInfoRequest{})))
	if info.Name != "Test" {
		t.Fatalf("grpc info = %v", info)
	}
}

func TestSeed(t *testing.T) {
	var e *env
	for _, name := range []string{"community", "owls"} {
		e = newEnv(t, func(c *Config) { c.Seed = name })
		var msgs, members, bots int
		e.s.db.r.QueryRow("SELECT COUNT(*) FROM messages").Scan(&msgs)
		e.s.db.r.QueryRow("SELECT COUNT(*) FILTER (WHERE kind = 1), COUNT(*) FILTER (WHERE kind = 2) FROM members").Scan(&members, &bots)
		if msgs < 250 || members < 8 || members > 15 || bots != 1 {
			t.Fatalf("%s: %d messages, %d members, %d bots", name, msgs, members, bots)
		}
		path := filepath.Join(e.dir, "bot-token.txt")
		fi, err := os.Stat(path)
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s: token file %v %v", name, fi, err)
		}
		tok, _ := os.ReadFile(path)
		bot := e.client(strings.TrimSpace(string(tok)))
		st := bot.state()
		if st.Me.Kind != v1.MemberKind_MEMBER_KIND_BOT || len(st.Channels) < 5 {
			t.Fatalf("%s: bot state = %v channels", name, len(st.Channels))
		}
		// The first real person to join owns the place.
		if p := e.join("ian"); p.me.Role != v1.MemberRole_MEMBER_ROLE_OWNER {
			t.Fatalf("%s: first human role = %v", name, p.me.Role)
		}
	}
	// Seeding again on a non-empty database is a no-op.
	if err := e.s.seed(ctx(), "owls"); err != nil {
		t.Fatal(err)
	}
	var n int
	e.s.db.r.QueryRow("SELECT COUNT(*) FROM members WHERE kind = 2").Scan(&n)
	if n != 1 {
		t.Fatalf("reseed created %d bots", n)
	}
}

func TestPureHelpers(t *testing.T) {
	for in, want := range map[string]string{"Ana Lopez!": "analopez", "x": "member", "": "member", "BOB_99": "bob_99"} {
		if got := usernameBase(in); got != want {
			t.Errorf("usernameBase(%q) = %q, want %q", in, got, want)
		}
	}
	if got := ftsQuery(`hello "world`); got != `"hello" """world"*` {
		t.Errorf("ftsQuery = %s", got)
	}
	for _, c := range []struct {
		after, oldest, newest int64
		want                  bool
	}{{0, 0, 0, false}, {0, 1, 5, false}, {5, 1, 5, false}, {6, 1, 5, true}, {2, 5, 9, true}, {4, 5, 9, false}} {
		if got := needResync(c.after, c.oldest, c.newest); got != c.want {
			t.Errorf("needResync(%v) = %v", c, got)
		}
	}
	if n, err := normalizeChannelName("  #Book Club "); n != "book-club" || err != nil {
		t.Errorf("normalize = %q %v", n, err)
	}
	if cleanFileName(`..\..\evil".txt`) != "evil.txt" || cleanFileName("..") != "file" {
		t.Error("cleanFileName")
	}
	m, mod, admin, owner := v1.MemberRole_MEMBER_ROLE_MEMBER, v1.MemberRole_MEMBER_ROLE_MODERATOR, v1.MemberRole_MEMBER_ROLE_ADMIN, v1.MemberRole_MEMBER_ROLE_OWNER
	for _, c := range []struct {
		actor, target v1.MemberRole
		want          bool
	}{{owner, admin, true}, {admin, mod, true}, {mod, m, true}, {owner, owner, false}, {admin, admin, false},
		{mod, mod, false}, {mod, admin, false}, {m, m, false}, {admin, owner, false}} {
		if got := outranks(c.actor, c.target); got != c.want {
			t.Errorf("outranks(%v, %v) = %v", c.actor, c.target, got)
		}
	}
	if !errors.Is(nil, nil) {
		t.Fatal()
	}
}

// A slow issuer must not stall key lookups for another issuer (0109).
func TestJWKSSlowIssuerDoesNotBlockOthers(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		http.NotFound(w, r)
	}))
	defer slow.Close()
	defer close(release)
	fast := newIssuer(t)
	j := &jwks{client: &http.Client{Timeout: 10 * time.Second}, now: time.Now, byIss: map[string]*issuerKeys{}}
	go j.key(slow.URL, "k1")
	<-entered
	got := make(chan error, 1)
	go func() { _, err := j.key(fast.url, fast.kid); got <- err }()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fast issuer waited for the slow one")
	}
}
