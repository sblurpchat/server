package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

//go:embed migrations/*.sql
var migrations embed.FS

// db has one write connection behind a one-slot lock (single writer) and a
// small pool of readers. WAL lets readers run while a write is in progress.
type db struct {
	w    *sql.DB
	r    *sql.DB
	lock chan struct{} // capacity 1; holding the slot is holding the writer
}

// writeWait caps how long writeTx waits for the writer. Past it the server is
// overloaded, and failing fast keeps the queue (goroutines, memory) bounded.
const writeWait = 5 * time.Second

func openDB(path string) (*db, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	w, err := sql.Open("sqlite", dsn+"&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite", dsn+"&_pragma=query_only(1)")
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	d := &db{w: w, r: r, lock: make(chan struct{}, 1)}
	if err := d.migrate(); err != nil {
		d.close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

func (d *db) close() {
	d.r.Close()
	d.w.Close()
}

// migrate applies migrations/NNN_*.sql in order, tracked by PRAGMA user_version.
func (d *db) migrate() error {
	var version int
	if err := d.w.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	names, _ := fs.Glob(migrations, "migrations/*.sql")
	sort.Strings(names)
	for i, name := range names {
		if i+1 <= version {
			continue
		}
		body, _ := migrations.ReadFile(name)
		tx, err := d.w.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// queryer is satisfied by *sql.DB and *sql.Tx.
type queryer interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

// wtx is a write transaction that also collects the events it emits. They
// are published to the hub after commit, in seq order.
type wtx struct {
	*sql.Tx
	ctx     context.Context
	s       *Server
	seq     int64
	pending []published
}

type published struct {
	ev       *v1.Event
	audience map[string]bool // nil = every member
}

// writeTx runs fn in the single write transaction. Events are published
// while the write lock is still held, so subscribers see them in seq order.
// It gives up with Unavailable if the writer stays busy for s.writeWait.
func (s *Server) writeTx(ctx context.Context, fn func(t *wtx) error) error {
	wait := time.NewTimer(s.writeWait)
	defer wait.Stop()
	select {
	case s.db.lock <- struct{}{}:
	case <-wait.C:
		return errf(connect.CodeUnavailable, "server is busy, try again")
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.db.lock }()
	tx, err := s.db.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	t := &wtx{Tx: tx, ctx: ctx, s: s}
	if err := fn(t); err != nil {
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, p := range t.pending {
		s.hub.publish(p.ev, p.audience)
	}
	return nil
}

// nextSeq reserves the next event seq. Safe because there is one writer.
func (t *wtx) nextSeq() (int64, error) {
	if t.seq == 0 {
		var err error
		if t.seq, err = currentSeq(t.ctx, t); err != nil {
			return 0, err
		}
	}
	t.seq++
	return t.seq, nil
}

// emit persists ev. A zero ev.Seq takes the next one; a set one must come
// from nextSeq. A non-empty scopeChannel limits the event to that channel's
// members, scopeMember to one member.
func (t *wtx) emit(ev *v1.Event, scopeChannel, scopeMember string) error {
	if ev.Seq == 0 {
		var err error
		if ev.Seq, err = t.nextSeq(); err != nil {
			return err
		}
	}
	if ev.AtMs == 0 {
		ev.AtMs = t.s.nowMs()
	}
	payload, err := proto.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := t.ExecContext(t.ctx, "INSERT INTO events(seq, at_ms, scope_channel, scope_member, payload) VALUES (?,?,?,?,?)",
		ev.Seq, ev.AtMs, scopeChannel, scopeMember, payload); err != nil {
		return err
	}
	var aud map[string]bool
	switch {
	case scopeMember != "":
		aud = map[string]bool{scopeMember: true}
	case scopeChannel != "":
		ids, err := channelMemberIDs(t.ctx, t, scopeChannel)
		if err != nil {
			return err
		}
		aud = map[string]bool{}
		for _, id := range ids {
			aud[id] = true
		}
	}
	// A copy: subscribers share it, so it must not alias anything the caller returns.
	t.pending = append(t.pending, published{proto.Clone(ev).(*v1.Event), aud})
	return nil
}

func channelMemberIDs(ctx context.Context, q queryer, channelID string) ([]string, error) {
	return scanIDs(q.QueryContext(ctx, "SELECT member_id FROM channel_members WHERE channel_id = ? ORDER BY member_id", channelID))
}

// scanIDs reads a one-column string result and closes rows.
func scanIDs(rows *sql.Rows, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// reportedFiles are the uploads an open report keeps (1256).
const reportedFiles = `SELECT j.value FROM reports r, json_each(r.attachment_ids) j WHERE r.resolved_at_ms = 0`

// deleteAttachments deletes the uploads of the messages in the JSON array ids
// and their video posters, returning the ids of the files to remove. Uploads
// an open report keeps are only unlinked; prune deletes them once no open
// report keeps them.
func deleteAttachments(t *wtx, ids string) ([]string, error) {
	if _, err := t.ExecContext(t.ctx, `UPDATE attachments SET message_id = NULL WHERE message_id IN (SELECT value FROM json_each(?))
		AND id IN (`+reportedFiles+`)`, ids); err != nil {
		return nil, err
	}
	return scanIDs(t.QueryContext(t.ctx, `DELETE FROM attachments WHERE message_id IN (SELECT value FROM json_each(?1))
	OR id IN (SELECT poster_id FROM attachments WHERE poster_id != '' AND message_id IN (SELECT value FROM json_each(?1))) RETURNING id`, ids))
}

// prune drops old events: those outside both the newest keepEvents and the
// last keepFor. Subscribers behind the oldest kept seq get resync. It also
// deletes uploads that were never attached to a message within orphanAfter,
// and reports resolved more than keepResolvedReports ago.
func (s *Server) prune(ctx context.Context) error {
	now := s.now()
	cutoff := now.Add(-s.cfg.KeepFor).UnixMilli()
	var orphans []string
	err := s.writeTx(ctx, func(t *wtx) error {
		if _, err := t.ExecContext(ctx, "DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ? AND at_ms < ?", s.cfg.KeepEvents, cutoff); err != nil {
			return err
		}
		if _, err := t.ExecContext(ctx, "DELETE FROM reports WHERE resolved_at_ms != 0 AND resolved_at_ms < ?", now.Add(-keepResolvedReports).UnixMilli()); err != nil {
			return err
		}
		var err error
		orphans, err = scanIDs(t.QueryContext(ctx, `DELETE FROM attachments WHERE message_id IS NULL AND created_at_ms < ?
			AND id NOT IN (SELECT value FROM settings WHERE key IN ('banner', 'icon')) AND id NOT IN (SELECT header_image_id FROM channels)
			AND id NOT IN (`+reportedFiles+`)
			AND id NOT IN (SELECT poster_id FROM attachments WHERE poster_id != '')
			AND id NOT IN (SELECT substr(avatar_url, 8, instr(substr(avatar_url, 8), '/') - 1) FROM members WHERE avatar_url LIKE '/files/%') RETURNING id`, now.Add(-orphanAfter).UnixMilli()))
		return err
	})
	if err != nil {
		return err
	}
	for _, id := range orphans {
		os.Remove(filepath.Join(s.filesDir, id))
	}
	return nil
}

const orphanAfter = 24 * time.Hour

// keepResolvedReports bounds the moderation log (1257); reports of DMs hold
// DM text, so they should not stay forever.
const keepResolvedReports = 90 * 24 * time.Hour

// maxRetentionDays caps the retention setting at about ten years.
const maxRetentionDays = 3650

// retentionDays is the community's message retention; 0 keeps forever.
func retentionDays(ctx context.Context, q queryer) (int32, error) {
	var d int32
	err := q.QueryRowContext(ctx, "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'retention_days'), 0)").Scan(&d)
	return d, err
}

// retentionCutoff is the created_at_ms below which messages are gone; 0 = keep all.
func (s *Server) retentionCutoff(ctx context.Context, q queryer) (int64, error) {
	d, err := retentionDays(ctx, q)
	if err != nil || d <= 0 {
		return 0, err
	}
	return s.now().Add(-time.Duration(d) * 24 * time.Hour).UnixMilli(), nil
}

const pruneBatch = 500

// expiredIDs is a JSON array of up to pruneBatch expired roots and their
// replies. The thread_root_id != check lets the replies use the partial
// messages_thread index; without it each batch scanned every message (1155).
const expiredIDs = `WITH r AS (SELECT id FROM messages WHERE thread_root_id = '' AND created_at_ms < ? ORDER BY created_at_ms LIMIT ?)
	SELECT json_group_array(id) FROM (SELECT id FROM r UNION ALL SELECT id FROM messages WHERE thread_root_id != '' AND thread_root_id IN (SELECT id FROM r))`

var prunePause = 50 * time.Millisecond

// pruneMessages deletes what the retention setting expires: top-level
// messages older than the cutoff with all their thread replies, reactions and
// files, plus old events (they hold message text too). The messages_ad
// trigger drops the search rows. Each batch of pruneBatch roots is its own
// short write tx with a pause after it, so chat writes get the writer between
// batches. Clients get no per-message events; they hide messages older than
// the cutoff from GetServerInfo.retention_days.
func (s *Server) pruneMessages(ctx context.Context) error {
	for {
		cutoff, err := s.retentionCutoff(ctx, s.db.r)
		if err != nil || cutoff == 0 {
			return err
		}
		var files []string
		var msgs, evs int64
		err = s.writeTx(ctx, func(t *wtx) error {
			var ids string // JSON array of the roots and their replies
			err := t.QueryRowContext(ctx, expiredIDs, cutoff, pruneBatch).Scan(&ids)
			if err != nil {
				return err
			}
			if _, err := t.ExecContext(ctx, "DELETE FROM reactions WHERE message_id IN (SELECT value FROM json_each(?))", ids); err != nil {
				return err
			}
			files, err = deleteAttachments(t, ids)
			if err != nil {
				return err
			}
			res, err := t.ExecContext(ctx, "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))", ids)
			if err != nil {
				return err
			}
			msgs, _ = res.RowsAffected()
			res, err = t.ExecContext(ctx, "DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at_ms < ? ORDER BY seq LIMIT ?)", cutoff, pruneBatch)
			if err != nil {
				return err
			}
			evs, _ = res.RowsAffected()
			return nil
		})
		if err != nil {
			return err
		}
		for _, id := range files {
			os.Remove(filepath.Join(s.filesDir, id))
		}
		if msgs < pruneBatch && evs < pruneBatch {
			return nil
		}
		select {
		case <-time.After(prunePause):
		case <-s.stop:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// newID returns a UUIDv7: 48-bit unix ms, version 7, variant 10, random rest.
func newID(now time.Time) string {
	var b [16]byte
	rand.Read(b[:])
	binary.BigEndian.PutUint64(b[:8], uint64(now.UnixMilli())<<16|uint64(b[6])<<8|uint64(b[7]))
	b[6] = 0x70 | b[6]&0x0f
	b[8] = 0x80 | b[8]&0x3f
	h := hex.EncodeToString(b[:])
	return strings.Join([]string{h[:8], h[8:12], h[12:16], h[16:20], h[20:]}, "-")
}
