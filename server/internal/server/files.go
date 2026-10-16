package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

const maxUpload = 25 << 20

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// cleanFileName keeps a display name safe for headers and URLs.
func cleanFileName(name string) string {
	name = name[strings.LastIndexAny(name, `/\`)+1:]
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '"' {
			return -1
		}
		return r
	}, name))
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// upload stores one multipart "file" part and returns the Attachment as
// protojson. The client passes its id in SendMessage.attachment_ids.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	id, err := s.authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		httpError(w, http.StatusUnauthorized, "invalid or missing bearer token")
		return
	}
	if id.member == nil {
		httpError(w, http.StatusForbidden, "join this community first")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20) // room for multipart framing
	mr, err := r.MultipartReader()
	if err != nil {
		httpError(w, http.StatusBadRequest, "expected multipart/form-data")
		return
	}
	var part io.Reader
	var name string
	for {
		p, err := mr.NextPart()
		if err != nil {
			httpError(w, http.StatusBadRequest, "no \"file\" part in the form")
			return
		}
		if p.FormName() == "file" {
			part, name = p, cleanFileName(p.FileName())
			break
		}
	}
	tmp, err := os.CreateTemp(s.filesDir, ".upload-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot store file")
		return
	}
	defer os.Remove(tmp.Name()) // no-op after the rename
	defer tmp.Close()
	head := make([]byte, 512)
	n, err := io.ReadFull(part, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		httpError(w, http.StatusBadRequest, "upload failed")
		return
	}
	if n == 0 {
		httpError(w, http.StatusBadRequest, "file is empty")
		return
	}
	ctype := http.DetectContentType(head[:n])
	rest, err := io.Copy(tmp, io.MultiReader(bytes.NewReader(head[:n]), io.LimitReader(part, maxUpload+1-int64(n))))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpError(w, http.StatusRequestEntityTooLarge, "file is larger than 25 MB")
		} else {
			httpError(w, http.StatusBadRequest, "upload failed")
		}
		return
	}
	if rest > maxUpload {
		httpError(w, http.StatusRequestEntityTooLarge, "file is larger than 25 MB")
		return
	}
	a := &v1.Attachment{Id: newID(s.now()), Name: name, ContentType: ctype, Size: rest}
	if strings.HasPrefix(ctype, "image/") {
		if _, err := tmp.Seek(0, io.SeekStart); err == nil {
			if cfg, _, err := image.DecodeConfig(tmp); err == nil {
				a.Width, a.Height = int32(cfg.Width), int32(cfg.Height)
			}
		}
	}
	if err := tmp.Sync(); err != nil || os.Rename(tmp.Name(), filepath.Join(s.filesDir, a.Id)) != nil {
		httpError(w, http.StatusInternalServerError, "cannot store file")
		return
	}
	a.Url = fileURL(a.Id, a.Name)
	err = s.writeTx(r.Context(), func(t *wtx) error {
		_, err := t.ExecContext(r.Context(), `INSERT INTO attachments(id, uploader_id, name, content_type, size, width, height, created_at_ms)
			VALUES (?,?,?,?,?,?,?,?)`, a.Id, id.member.Id, a.Name, a.ContentType, a.Size, a.Width, a.Height, s.nowMs())
		return err
	})
	if err != nil {
		os.Remove(filepath.Join(s.filesDir, a.Id))
		s.log.Error("store attachment", "err", err)
		httpError(w, http.StatusInternalServerError, "cannot store file")
		return
	}
	body, _ := protojson.Marshal(a)
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// serveFile serves an upload to anyone who knows its unguessable id.
// Uploaded content is untrusted: it never runs as a page on this origin.
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request) {
	var name, ctype string
	var created int64
	err := s.db.r.QueryRowContext(r.Context(), "SELECT name, content_type, created_at_ms FROM attachments WHERE id = ?", r.PathValue("id")).
		Scan(&name, &ctype, &created)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.filesDir, r.PathValue("id")))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	disp := "attachment"
	if strings.HasPrefix(ctype, "image/") || strings.HasPrefix(ctype, "video/") || strings.HasPrefix(ctype, "audio/") {
		disp = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": name}))
	http.ServeContent(w, r, "", time.UnixMilli(created), f)
}
