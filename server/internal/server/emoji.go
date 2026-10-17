package server

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"io"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

const (
	maxEmojiBytes   = 256 << 10
	maxEmojiSide    = 512
	maxEmojiRequest = 64 << 20 // one POST /emoji, zips included
	maxZipEntries   = 10000
)

var emojiNameRE = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

var emojiExt = map[string]string{"image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}

// emojiName makes an emoji name from a file name or a path in a zip:
// "pack/Party Parrot.GIF" becomes "party_parrot". Runs of other characters
// become one "_". It returns "" when nothing usable is left.
func emojiName(file string) string {
	base := path.Base(strings.ReplaceAll(file, `\`, "/"))
	if i := strings.LastIndexByte(base, '.'); i > 0 {
		base = base[:i]
	}
	var b strings.Builder
	gap := false
	for _, r := range strings.ToLower(base) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			if gap && b.Len() > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r)
			gap = false
		} else {
			gap = true
		}
	}
	return strings.Trim(b.String()[:min(b.Len(), 64)], "_-")
}

// checkEmojiImage returns the image's content type, or why it cannot be an
// emoji.
func checkEmojiImage(b []byte) (string, error) {
	if len(b) > maxEmojiBytes {
		return "", fmt.Errorf("larger than %d KB", maxEmojiBytes>>10)
	}
	ct := http.DetectContentType(b)
	if emojiExt[ct] == "" {
		return "", errors.New("not a PNG, GIF or WebP image")
	}
	w, h := imageSize(b) // WebP
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(b)); err == nil {
		w, h = cfg.Width, cfg.Height
	}
	if w <= 0 || h <= 0 {
		return "", errors.New("cannot read the image size")
	}
	if w > maxEmojiSide || h > maxEmojiSide {
		return "", fmt.Errorf("%dx%d is larger than %dx%d", w, h, maxEmojiSide, maxEmojiSide)
	}
	return ct, nil
}

// emojiList is GET /emoji's body for one emoji_version, built once.
type emojiList struct {
	version  int64
	body, gz []byte
}

type emojiCache struct {
	mu   sync.Mutex
	list *emojiList
}

func emojiVersion(ctx context.Context, q queryer) (int64, error) {
	var v string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key = 'emoji_version'").Scan(&v)
	if err != nil {
		return 0, ignoreNoRows(err)
	}
	return strconv.ParseInt(v, 10, 64)
}

func ignoreNoRows(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}

// currentEmoji returns the list for the current version, rebuilding it only
// when an emoji change bumped the version. A revalidation costs one read.
func (s *Server) currentEmoji(ctx context.Context) (*emojiList, error) {
	v, err := emojiVersion(ctx, s.db.r)
	if err != nil {
		return nil, err
	}
	c := &s.emoji
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.list != nil && c.list.version == v {
		return c.list, nil
	}
	rows, err := s.db.r.QueryContext(ctx, "SELECT id, name FROM emoji ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &v1.ListEmojiResponse{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out.Emoji = append(out.Emoji, &v1.CustomEmoji{Name: name, Url: "/emoji/" + strconv.FormatInt(id, 10)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	l := &emojiList{version: v}
	if l.body, err = protojson.Marshal(out); err != nil {
		return nil, err
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(l.body)
	zw.Close()
	l.gz = gz.Bytes()
	c.list = l
	return l, nil
}

// emojiChanged bumps emoji_version and tells every member.
func emojiChanged(t *wtx) error {
	seq, err := t.nextSeq()
	if err != nil {
		return err
	}
	if _, err := t.ExecContext(t.ctx, "INSERT INTO settings(key, value) VALUES ('emoji_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", strconv.FormatInt(seq, 10)); err != nil {
		return err
	}
	return t.emit(&v1.Event{Seq: seq, Kind: &v1.Event_EmojiChanged{EmojiChanged: true}}, "", "")
}

// httpMember authenticates a plain HTTP request. It writes the error and
// returns nil when the caller is not a member.
func (s *Server) httpMember(w http.ResponseWriter, r *http.Request) *memberRow {
	id, err := s.authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		httpError(w, http.StatusUnauthorized, "invalid or missing bearer token")
		return nil
	}
	if id.member == nil {
		httpError(w, http.StatusForbidden, "join this community first")
		return nil
	}
	return id.member
}

// listEmoji serves every custom emoji as one protojson list with a weak
// ETag (the version), gzipped when the client accepts it.
func (s *Server) listEmoji(w http.ResponseWriter, r *http.Request) {
	if s.httpMember(w, r) == nil {
		return
	}
	l, err := s.currentEmoji(r.Context())
	if err != nil {
		s.log.Error("list emoji", "err", err)
		httpError(w, http.StatusInternalServerError, "cannot list emoji")
		return
	}
	h := w.Header()
	etag := `W/"` + strconv.FormatInt(l.version, 10) + `"`
	h.Set("ETag", etag)
	h.Set("Cache-Control", "private, no-cache")
	h.Set("Vary", "Accept-Encoding, Authorization")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", "application/json")
	body := l.body
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		body = l.gz
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.Write(body)
}

// serveEmoji serves one image. Ids are never reused, so it caches forever.
func (s *Server) serveEmoji(w http.ResponseWriter, r *http.Request) {
	var ct string
	var data []byte
	err := s.db.r.QueryRowContext(r.Context(), "SELECT content_type, data FROM emoji WHERE id = ?", r.PathValue("id")).Scan(&ct, &data)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(data)
}

type emojiFile struct {
	res  *v1.EmojiUploadResult
	ct   string
	data []byte
}

// readEmojiFiles turns one uploaded file (an image or a zip of images) into
// candidates. Rejected ones carry their reason.
func readEmojiFiles(file string, data []byte) []emojiFile {
	if http.DetectContentType(data) != "application/zip" {
		return []emojiFile{checkEmojiFile(file, data)}
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return []emojiFile{{res: &v1.EmojiUploadResult{File: file, Status: v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED, Error: "not a valid zip"}}}
	}
	var out []emojiFile
	for _, f := range zr.File {
		base := path.Base(f.Name)
		if f.FileInfo().IsDir() || strings.HasPrefix(base, ".") || strings.HasPrefix(f.Name, "__MACOSX/") {
			continue
		}
		if len(out) == maxZipEntries {
			out = append(out, emojiFile{res: &v1.EmojiUploadResult{File: file, Status: v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED,
				Error: fmt.Sprintf("only the first %d files were read", maxZipEntries)}})
			break
		}
		name := file + "/" + f.Name
		if f.UncompressedSize64 > maxEmojiBytes {
			out = append(out, emojiFile{res: &v1.EmojiUploadResult{File: name, Name: emojiName(f.Name), Status: v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED,
				Error: fmt.Sprintf("larger than %d KB", maxEmojiBytes>>10)}})
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxEmojiBytes+1)) // the header size may lie
		rc.Close()
		if err != nil {
			out = append(out, emojiFile{res: &v1.EmojiUploadResult{File: name, Status: v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED, Error: "cannot read it from the zip"}})
			continue
		}
		out = append(out, checkEmojiFile(name, b))
	}
	return out
}

func checkEmojiFile(file string, data []byte) emojiFile {
	f := emojiFile{res: &v1.EmojiUploadResult{File: file, Name: emojiName(file)}, data: data}
	var err error
	if !emojiNameRE.MatchString(f.res.Name) {
		err = errors.New("no usable name; use a-z, 0-9, - and _")
	} else {
		f.ct, err = checkEmojiImage(data)
	}
	if err != nil {
		f.res.Status, f.res.Error = v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED, err.Error()
	}
	return f
}

// uploadEmoji adds every "file" part (images, or zips of images) as emoji
// named after the file. A taken name is skipped, never replaced.
func (s *Server) uploadEmoji(w http.ResponseWriter, r *http.Request) {
	m := s.httpMember(w, r)
	if m == nil {
		return
	}
	if !canModerate(m) {
		httpError(w, http.StatusForbidden, "only moderators and admins can add emoji")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxEmojiRequest)
	mr, err := r.MultipartReader()
	if err != nil {
		httpError(w, http.StatusBadRequest, "expected multipart/form-data")
		return
	}
	var files []emojiFile
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("upload is larger than %d MB; send fewer files at once", maxEmojiRequest>>20))
			} else {
				httpError(w, http.StatusBadRequest, "upload failed")
			}
			return
		}
		if p.FormName() != "file" {
			continue
		}
		data, err := io.ReadAll(p)
		if err != nil {
			httpError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("upload is larger than %d MB; send fewer files at once", maxEmojiRequest>>20))
			return
		}
		files = append(files, readEmojiFiles(p.FileName(), data)...)
	}
	err = s.writeTx(r.Context(), func(t *wtx) error {
		added := false
		for _, f := range files {
			if f.res.Status != v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_UNSPECIFIED {
				continue
			}
			res, err := t.ExecContext(r.Context(), "INSERT INTO emoji(name, content_type, created_by, created_at_ms, data) VALUES (?,?,?,?,?) ON CONFLICT(name) DO NOTHING",
				f.res.Name, f.ct, m.Id, s.nowMs(), f.data)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				f.res.Status, added = v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_ADDED, true
			} else {
				f.res.Status, f.res.Error = v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_EXISTS, "an emoji with this name exists"
			}
		}
		if added {
			return emojiChanged(t)
		}
		return nil
	})
	if err != nil {
		s.log.Error("add emoji", "err", err)
		httpError(w, http.StatusInternalServerError, "cannot store emoji")
		return
	}
	out := &v1.UploadEmojiResponse{}
	for _, f := range files {
		out.Results = append(out.Results, f.res)
	}
	body, _ := protojson.Marshal(out)
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// exportEmoji streams every emoji as name.ext in one zip, which uploads
// again as is on another server.
func (s *Server) exportEmoji(w http.ResponseWriter, r *http.Request) {
	if s.httpMember(w, r) == nil {
		return
	}
	// ponytail: holds one reader connection while it streams; buffer to a
	// temp file first if slow downloads ever starve the pool.
	rows, err := s.db.r.QueryContext(r.Context(), "SELECT name, content_type, created_at_ms, data FROM emoji ORDER BY name")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot export emoji")
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "emoji.zip"}))
	zw := zip.NewWriter(w)
	for rows.Next() {
		var name, ct string
		var at int64
		var data []byte
		if err := rows.Scan(&name, &ct, &at, &data); err != nil {
			return
		}
		// Images are compressed already, so Store, not Deflate.
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: name + emojiExt[ct], Method: zip.Store, Modified: s.now().UTC()})
		if err != nil {
			return
		}
		if _, err := fw.Write(data); err != nil {
			return
		}
	}
	zw.Close()
}

func (s *Server) DeleteEmoji(ctx context.Context, req *connect.Request[v1.DeleteEmojiRequest]) (*connect.Response[v1.DeleteEmojiResponse], error) {
	if !canModerate(me(ctx)) {
		return nil, errf(connect.CodePermissionDenied, "only moderators and admins can delete emoji")
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		res, err := t.ExecContext(ctx, "DELETE FROM emoji WHERE name = ?", req.Msg.Name)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errf(connect.CodeNotFound, "no emoji named %q", req.Msg.Name)
		}
		return emojiChanged(t)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DeleteEmojiResponse{}), nil
}
