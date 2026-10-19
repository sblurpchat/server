package server

import (
	"testing"

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
