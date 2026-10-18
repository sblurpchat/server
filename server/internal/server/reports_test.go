package server

import (
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestSeesReport(t *testing.T) {
	owner, admin, mod, member := v1.MemberRole_MEMBER_ROLE_OWNER, v1.MemberRole_MEMBER_ROLE_ADMIN, v1.MemberRole_MEMBER_ROLE_MODERATOR, v1.MemberRole_MEMBER_ROLE_MEMBER
	for _, c := range []struct {
		viewer, author v1.MemberRole
		want           bool
	}{
		{mod, member, true}, {mod, mod, false}, {mod, admin, false},
		{admin, mod, true}, {admin, admin, false},
		{owner, admin, true}, {owner, owner, true},
		{member, member, false},
	} {
		if got := seesReport(c.viewer, c.author); got != c.want {
			t.Errorf("seesReport(%v, %v) = %v", c.viewer, c.author, got)
		}
	}
}

func TestReportMessage(t *testing.T) {
	e := newEnv(t)
	ok := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	ana, bob, cat, dan := e.join("ana"), e.join("bob"), e.join("cat"), e.join("dan") // ana owns
	ok(ana.setRole(cat.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR))
	report := func(c *client, msg, note string) error {
		_, err := c.srv.ReportMessage(ctx(), connect.NewRequest(&v1.ReportMessageRequest{MessageId: msg, Note: note}))
		return err
	}
	list := func(c *client) []*v1.Report {
		return must(c.srv.ListReports(ctx(), connect.NewRequest(&v1.ListReportsRequest{}))).Reports
	}
	talk := ana.channel("talk", v1.ChannelKind_CHANNEL_KIND_TEXT)
	secret := ana.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	rude := bob.send(talk.Id, "rude words")
	hidden := ana.send(secret.Id, "admins only")
	dm := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{dan.me.Id}}))).Channel
	dmMsg := bob.send(dm.Id, "dm threat")

	wantCode(t, report(bob, rude.Id, ""), connect.CodeInvalidArgument) // own message
	wantCode(t, report(dan, hidden.Id, ""), connect.CodeNotFound)      // cannot see it
	ok(report(dan, rude.Id, "first"))
	ok(report(dan, rude.Id, "not nice")) // again: replaces the note
	ok(report(ana, rude.Id, ""))
	e.clock.Advance(time.Second)
	ok(report(dan, dmMsg.Id, "scary"))

	// Members, the reporter included, cannot list reports.
	_, err := dan.srv.ListReports(ctx(), connect.NewRequest(&v1.ListReportsRequest{}))
	wantCode(t, err, connect.CodePermissionDenied)

	// The copy outlives a delete, and DM content reaches the moderator only through the report.
	must(bob.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: dmMsg.Id})))
	got := list(cat)
	if len(got) != 3 {
		t.Fatalf("cat sees %d reports", len(got))
	}
	d := got[0]
	if !d.Dm || d.Message.Text != "dm threat" || d.Note != "scary" || d.Reporter.GetId() != dan.me.Id || d.Author.GetId() != bob.me.Id {
		t.Fatalf("dm report = %v", d)
	}
	notes := map[string]bool{}
	for _, r := range got[1:] {
		notes[r.Note] = true
		if r.Dm || r.Message.Id != rude.Id || r.Message.Text != "rude words" {
			t.Fatalf("report = %v", r)
		}
	}
	if !notes["not nice"] || notes["first"] {
		t.Fatalf("notes = %v", notes)
	}
	_, err = cat.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: dm.Id}))
	wantCode(t, err, connect.CodeNotFound)

	// A report about a moderator is for those who outrank them.
	catMsg := cat.send(talk.Id, "mod says")
	ok(report(dan, catMsg.Id, ""))
	if n := len(list(cat)); n != 3 {
		t.Fatalf("cat sees a report about herself: %d", n)
	}
	if n := len(list(ana)); n != 4 {
		t.Fatalf("owner sees %d", n)
	}
	var catReport string
	for _, r := range list(ana) {
		if r.Message.Id == catMsg.Id {
			catReport = r.Id
		}
	}
	_, err = cat.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: catReport}))
	wantCode(t, err, connect.CodeNotFound)
	_, err = dan.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: catReport}))
	wantCode(t, err, connect.CodePermissionDenied)

	// Resolving one report clears every report of that message.
	must(cat.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: got[1].Id})))
	left := list(ana)
	if len(left) != 2 {
		t.Fatalf("after resolve: %d", len(left))
	}
	for _, r := range left {
		if r.Message.Id == rude.Id {
			t.Fatal("other report of the same message stays open")
		}
	}

	// Rate limit: dan used 5 (two failed attempts count too); then one every 10 minutes.
	more := bob.send(talk.Id, "more")
	wantCode(t, report(dan, more.Id, ""), connect.CodeResourceExhausted)
	e.clock.Advance(10 * time.Minute)
	ok(report(dan, more.Id, ""))
	wantCode(t, report(dan, more.Id, ""), connect.CodeResourceExhausted)
}
