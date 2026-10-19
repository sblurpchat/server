package server

import (
	"os"
	"path/filepath"
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

// 1255, 1256, 1257: counts for moderators, files kept while open, a log of resolved reports.
func TestReportLog(t *testing.T) {
	e := newEnv(t)
	ana, bob, cat, dan := e.join("ana"), e.join("bob"), e.join("cat"), e.join("dan")
	must0(t, ana.setRole(cat.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR))
	catID := cat.me.Id
	report := func(c *client, msg string) {
		t.Helper()
		must(c.srv.ReportMessage(ctx(), connect.NewRequest(&v1.ReportMessageRequest{MessageId: msg})))
	}
	list := func(c *client, resolved bool) []*v1.Report {
		return must(c.srv.ListReports(ctx(), connect.NewRequest(&v1.ListReportsRequest{Resolved: resolved}))).Reports
	}
	fileExists := func(id string) bool {
		_, err := os.Stat(filepath.Join(e.dir, "files", id))
		return err == nil
	}
	count := func(s *subscription) int32 {
		t.Helper()
		return s.next(func(ev *v1.Event) bool { _, ok := ev.Kind.(*v1.Event_OpenReports); return ok }, nil).GetOpenReports()
	}

	dm := must(bob.chat.OpenDM(ctx(), connect.NewRequest(&v1.OpenDMRequest{MemberIds: []string{dan.me.Id}}))).Channel
	_, f := bob.upload("note.txt", []byte("threat"))
	msg := must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: dm.Id, Text: "see file", AttachmentIds: []string{f.Id}}))).Message
	sub := cat.subscribe(cat.state().Seq)
	report(dan, msg.Id)
	if n := count(sub); n != 1 {
		t.Fatalf("event count %d", n)
	}
	if cat.state().OpenReports != 1 || ana.state().OpenReports != 1 || dan.state().OpenReports != 0 {
		t.Fatal("GetState open_reports")
	}

	// The file outlives a delete and the orphan prune while the report is open.
	must(bob.chat.DeleteMessage(ctx(), connect.NewRequest(&v1.DeleteMessageRequest{MessageId: msg.Id})))
	e.clock.Advance(25 * time.Hour)
	must0(t, e.s.prune(ctx()))
	cat, dan = e.client(e.token("cat")), e.client(e.token("dan")) // old tokens expired
	got := list(cat, false)
	if len(got) != 1 || len(got[0].Message.Attachments) != 1 || got[0].Message.Attachments[0].Id != f.Id || !fileExists(f.Id) {
		t.Fatalf("open report = %v", got)
	}

	sub = cat.subscribe(cat.state().Seq)
	must(cat.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: got[0].Id})))
	if n := count(sub); n != 0 {
		t.Fatalf("event count after resolve %d", n)
	}
	_, err := cat.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: got[0].Id}))
	wantCode(t, err, connect.CodeNotFound)
	done := list(cat, true)
	if len(list(cat, false)) != 0 || len(done) != 1 || done[0].ResolvedBy.GetId() != catID || done[0].ResolvedAtMs != e.clock.Now().UnixMilli() || done[0].Message.Text != "see file" {
		t.Fatalf("resolved = %v", done)
	}
	must0(t, e.s.prune(ctx()))
	if fileExists(f.Id) || len(list(cat, true)[0].Message.Attachments) != 0 {
		t.Fatal("file kept after resolve")
	}

	// A new report of a message after a resolve is a new open report.
	talk := e.client(e.token("ana")).channel("talk", v1.ChannelKind_CHANNEL_KIND_TEXT)
	bob = e.client(e.token("bob"))
	rude := bob.send(talk.Id, "rude")
	report(dan, rude.Id)
	must(cat.srv.ResolveReport(ctx(), connect.NewRequest(&v1.ResolveReportRequest{ReportId: list(cat, false)[0].Id})))
	report(dan, rude.Id)
	if len(list(cat, false)) != 1 || len(list(cat, true)) != 2 {
		t.Fatal("report after resolve")
	}

	// The log keeps 90 days.
	e.clock.Advance(91 * 24 * time.Hour)
	must0(t, e.s.prune(ctx()))
	cat = e.client(e.token("cat"))
	if len(list(cat, true)) != 0 || len(list(cat, false)) != 1 {
		t.Fatal("old resolved reports stay")
	}
}
