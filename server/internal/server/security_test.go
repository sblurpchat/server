package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// A bot is never a moderator or admin: its token is a long-lived secret with
// no login behind it, and an admin bot could install plugins and mint bots.
func TestBotRoleStaysMember(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	bot := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"}))).Bot
	for _, r := range []v1.MemberRole{v1.MemberRole_MEMBER_ROLE_ADMIN, v1.MemberRole_MEMBER_ROLE_MODERATOR} {
		wantCode(t, ana.setRole(bot.Id, r), connect.CodeInvalidArgument)
	}
	if err := ana.setRole(bot.Id, v1.MemberRole_MEMBER_ROLE_MEMBER); err != nil {
		t.Fatal(err)
	}
}

// A ban stays until someone of at least the banner's rank lifts it.
func TestUnbanNeedsBannerRank(t *testing.T) {
	e := newEnv(t)
	ana, bob, cy, dee := e.join("ana"), e.join("bob"), e.join("cy"), e.join("dee")
	if err := ana.setRole(bob.me.Id, v1.MemberRole_MEMBER_ROLE_ADMIN); err != nil {
		t.Fatal(err)
	}
	if err := ana.setRole(cy.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR); err != nil {
		t.Fatal(err)
	}
	must(ana.srv.BanMember(ctx(), connect.NewRequest(&v1.BanMemberRequest{MemberId: dee.me.Id})))
	unban := func(c *client) error {
		_, err := c.srv.UnbanMember(ctx(), connect.NewRequest(&v1.UnbanMemberRequest{MemberId: dee.me.Id}))
		return err
	}
	wantCode(t, unban(cy), connect.CodePermissionDenied)
	wantCode(t, unban(bob), connect.CodePermissionDenied)
	if err := unban(ana); err != nil {
		t.Fatal(err)
	}
}

// Tokens with no subject, or not valid yet, are refused (1295).
func TestJWTRefusesEmptySubAndFutureNbf(t *testing.T) {
	e := newEnv(t)
	hdr := map[string]any{"alg": "EdDSA", "kid": e.iss.kid}
	empty := e.claims("x")
	empty["sub"] = ""
	early := e.claims("dave")
	early["nbf"] = e.clock.Now().Add(10 * time.Minute).Unix()
	for name, c := range map[string]map[string]any{"empty sub": empty, "future nbf": early} {
		_, err := e.client(signJWT(e.iss.key, hdr, c)).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}
	// nbf within the clock skew is fine.
	early["nbf"] = e.clock.Now().Add(30 * time.Second).Unix()
	must(e.client(signJWT(e.iss.key, hdr, early)).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{})))
}

// A token from an untrusted issuer never makes the server fetch keys, so a
// token cannot point the server at a URL of the attacker's choice (1295).
func TestUntrustedIssuerFetchesNoKeys(t *testing.T) {
	var hits atomic.Int32
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer evil.Close()
	e := newEnv(t)
	c := e.claims("dave")
	c["iss"] = evil.URL
	_, err := e.client(signJWT(e.iss.key, map[string]any{"alg": "EdDSA", "kid": "k9"}, c)).srv.Join(ctx(), connect.NewRequest(&v1.JoinRequest{}))
	wantCode(t, err, connect.CodeUnauthenticated)
	if n := hits.Load(); n != 0 {
		t.Fatalf("untrusted issuer got %d requests", n)
	}
}

// Members and moderators cannot manage invites, roles or bots (1295).
func TestNonAdminsCannotManage(t *testing.T) {
	e := newEnv(t)
	ana, bob, mo := e.join("ana"), e.join("bob"), e.join("mo")
	must0(t, ana.setRole(mo.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR))
	inv := must(ana.srv.CreateInvite(ctx(), connect.NewRequest(&v1.CreateInviteRequest{}))).Invite
	role := must(ana.srv.CreateRole(ctx(), connect.NewRequest(&v1.CreateRoleRequest{Name: "crew"}))).Role
	bot := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"})))
	calls := map[string]func(c *client) error{
		"RevokeInvite": func(c *client) error {
			_, err := c.srv.RevokeInvite(ctx(), connect.NewRequest(&v1.RevokeInviteRequest{Code: inv.Code}))
			return err
		},
		"UpdateRole": func(c *client) error {
			_, err := c.srv.UpdateRole(ctx(), connect.NewRequest(&v1.UpdateRoleRequest{RoleId: role.Id, Name: new("mine")}))
			return err
		},
		"DeleteRole": func(c *client) error {
			_, err := c.srv.DeleteRole(ctx(), connect.NewRequest(&v1.DeleteRoleRequest{RoleId: role.Id}))
			return err
		},
		"RotateBotToken": func(c *client) error {
			_, err := c.bots.RotateBotToken(ctx(), connect.NewRequest(&v1.RotateBotTokenRequest{BotId: bot.Bot.Id}))
			return err
		},
		"DeleteBot": func(c *client) error {
			_, err := c.bots.DeleteBot(ctx(), connect.NewRequest(&v1.DeleteBotRequest{BotId: bot.Bot.Id}))
			return err
		},
	}
	for name, call := range calls {
		for _, c := range []*client{bob, mo} {
			if err := call(c); connect.CodeOf(err) != connect.CodePermissionDenied {
				t.Errorf("%s by %s: %v", name, c.me.Username, err)
			}
		}
	}
	// Nothing changed: the old bot token still works, and an admin can still do each.
	must(e.client(bot.Token).srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{})))
	for _, name := range []string{"RevokeInvite", "UpdateRole", "RotateBotToken", "DeleteRole", "DeleteBot"} {
		if err := calls[name](ana); err != nil {
			t.Errorf("%s by the owner: %v", name, err)
		}
	}
}

// -bot-rate limits bot writes, through the API and through /mcp with a bot
// token, and leaves people alone (1295). The default, 0, is unlimited.
func TestBotRateLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.BotRate, c.BotBurst = 1, 3 })
	e.realLimits()
	ana := e.join("ana")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	tok := must(ana.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"}))).Token
	bot := e.client(tok)
	if len(bot.state().Channels) != 1 {
		t.Fatal("a new bot is not in #general") // fixed in createBot (1295)
	}
	send := func(c *client) error {
		_, err := c.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, Text: "beep"}))
		return err
	}
	e.clock.Advance(time.Minute) // the setup calls used some of the bucket
	for i := range 3 {
		if err := send(bot); err != nil {
			t.Fatalf("bot message %d: %v", i, err)
		}
	}
	wantCode(t, send(bot), connect.CodeResourceExhausted)
	if text, isErr := e.tool(tok, "post_message", map[string]any{"channel": gen.Id, "text": "via mcp"}); !isErr || !strings.Contains(text, "too many requests") {
		t.Fatalf("/mcp skipped the bot limit: %s", text)
	}
	must0(t, send(ana))
	e.clock.Advance(time.Second)
	// /mcp takes a bot token and posts as the bot.
	if text, isErr := e.tool(tok, "post_message", map[string]any{"channel": gen.Id, "text": "via mcp"}); isErr {
		t.Fatalf("/mcp with a bot token: %s", text)
	}

	free := newEnv(t)
	owner := free.join("ana")
	g := owner.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	robo := free.client(must(owner.bots.CreateBot(ctx(), connect.NewRequest(&v1.CreateBotRequest{Username: "robo"}))).Token)
	free.realLimits()
	for i := range 30 {
		if _, err := robo.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: g.Id, Text: "beep"})); err != nil {
			t.Fatalf("default bot rate stopped message %d: %v", i, err)
		}
	}
}
