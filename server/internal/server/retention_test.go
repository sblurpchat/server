package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// TestRetention: with "delete after 30 days", the prune removes old messages
// with their replies (even newer ones), reactions, files and search rows, in
// batches, and keeps everything newer. ListMessages hides expired messages
// before the prune runs.
func TestRetention(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	gen := ana.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	_, file := ana.upload("old.txt", []byte("ancient file"))
	old := must(ana.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{
		ChannelId: gen.Id, Text: "ancient words", AttachmentIds: []string{file.Id}}))).Message
	must(bob.chat.React(ctx(), connect.NewRequest(&v1.ReactRequest{MessageId: old.Id, Emoji: "👍"})))
	e.clock.Advance(29 * 24 * time.Hour)
	bob = e.client(e.token("bob")) // the old token expired
	must(bob.chat.SendMessage(ctx(), connect.NewRequest(&v1.SendMessageRequest{ChannelId: gen.Id, ThreadRootId: old.Id, Text: "late reply"})))
	// Bulk old rows to make the prune take more than one batch.
	tx, err := e.s.db.w.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2*pruneBatch + 7 {
		if _, err := tx.Exec("INSERT INTO messages(id, channel_id, author_id, text, created_at_ms, created_seq, seq) VALUES (?,?,?,?,?,1,1)",
			newID(e.clock.Now()), gen.Id, old.AuthorId, "bulk", old.CreatedAtMs-int64(i+1)*3_600_000); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(2 * 24 * time.Hour)
	ana, bob = e.client(e.token("ana")), e.client(e.token("bob"))
	fresh := ana.send(gen.Id, "fresh words")

	_, err = bob.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{RetentionDays: new(int32(30))}))
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = ana.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{RetentionDays: new(int32(maxRetentionDays + 1))}))
	wantCode(t, err, connect.CodeInvalidArgument)
	if got := must(ana.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{RetentionDays: new(int32(30))}))).RetentionDays; got != 30 {
		t.Fatalf("settings retention = %d", got)
	}
	if got := must(ana.srv.GetServerInfo(ctx(), connect.NewRequest(&v1.GetServerInfoRequest{}))).RetentionDays; got != 30 {
		t.Fatalf("info retention = %d", got)
	}
	list := func() []*v1.Message {
		return must(ana.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: gen.Id, Limit: 200}))).Messages
	}
	if ms := list(); len(ms) != 1 || ms[0].Id != fresh.Id {
		t.Fatalf("list before prune = %d messages", len(ms))
	}

	if err := e.s.pruneMessages(ctx()); err != nil {
		t.Fatal(err)
	}
	count := func(q string, args ...any) int {
		var n int
		if err := e.s.db.r.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count("SELECT COUNT(*) FROM messages"); n != 1 {
		t.Fatalf("messages left = %d, want 1", n)
	}
	if n := count("SELECT COUNT(*) FROM reactions"); n != 0 {
		t.Fatalf("reactions left = %d", n)
	}
	if n := count("SELECT COUNT(*) FROM attachments WHERE id = ?", file.Id); n != 0 {
		t.Fatalf("attachment row left")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "files", file.Id)); !os.IsNotExist(err) {
		t.Fatalf("file on disk: %v", err)
	}
	if n := count("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'ancient OR bulk OR late'"); n != 0 {
		t.Fatalf("search rows left = %d", n)
	}
	if ms := list(); len(ms) != 1 || ms[0].Id != fresh.Id {
		t.Fatalf("list after prune = %d messages", len(ms))
	}

	// Back to forever: nothing more goes.
	must(ana.srv.UpdateServerSettings(ctx(), connect.NewRequest(&v1.UpdateServerSettingsRequest{RetentionDays: new(int32(0))})))
	e.clock.Advance(365 * 24 * time.Hour)
	if err := e.s.pruneMessages(ctx()); err != nil {
		t.Fatal(err)
	}
	if n := count("SELECT COUNT(*) FROM messages"); n != 1 {
		t.Fatalf("forever pruned: %d left", n)
	}
}
