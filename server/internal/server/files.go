package server

import (
	"bytes"
	"cmp"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
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
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protopath"
	"google.golang.org/protobuf/reflect/protorange"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

const maxUpload = 25 << 20

// File URLs are capabilities: /files/{id}/{name}?exp=<unix s>&sig=<hmac>.
// The server signs them only in responses to members who may see the file,
// so <img src> works without an Authorization header. exp is rounded up to
// the hour, so a URL is stable (and cacheable) for an hour and valid for one
// to two hours. Removing someone does not revoke URLs they already hold.
const fileURLLife = time.Hour

// loadFileKey reads the HMAC key for file URLs, creating it on first start.
func loadFileKey(path string) ([]byte, error) {
	key, err := os.ReadFile(path)
	if err == nil && len(key) == 32 {
		return key, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key = make([]byte, 32)
	rand.Read(key)
	return key, os.WriteFile(path, key, 0o600)
}

func fileSig(key []byte, id string, exp int64) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(id + "\n" + strconv.FormatInt(exp, 10)))
	return b64.EncodeToString(h.Sum(nil))
}

// signedFileURL adds exp and sig to an attachment's URL.
func signedFileURL(key []byte, id, name string, now time.Time) string {
	exp := now.Add(2 * fileURLLife).Truncate(fileURLLife).Unix()
	return fileURL(id, name) + "?exp=" + strconv.FormatInt(exp, 10) + "&sig=" + fileSig(key, id, exp)
}

// fileSigOK checks a file URL's exp and sig.
func fileSigOK(key []byte, id, expStr, sig string, now time.Time) bool {
	exp, err := strconv.ParseInt(expStr, 10, 64)
	return err == nil && now.Unix() <= exp && hmac.Equal([]byte(sig), []byte(fileSig(key, id, exp)))
}

// signURLs signs every Attachment.url in m, in place. Every RPC response
// and stream event passes through it (see interceptor).
func (s *Server) signURLs(m proto.Message) {
	now := s.now()
	protorange.Range(m.ProtoReflect(), func(p protopath.Values) error {
		if v, ok := p.Index(-1).Value.Interface().(protoreflect.Message); ok {
			if a, ok := v.Interface().(*v1.Attachment); ok && a.Id != "" {
				a.Url = signedFileURL(s.fileKey, a.Id, a.Name, now)
			}
			if m, ok := v.Interface().(*v1.Member); ok {
				s.signAvatar(m, now)
			}
		}
		return nil
	})
}

// sniffType is http.DetectContentType plus AVIF and HEIF, which it does
// not know.
func sniffType(head []byte) string {
	ct := http.DetectContentType(head)
	if ct == "application/octet-stream" && len(head) >= 12 && string(head[4:8]) == "ftyp" {
		switch string(head[8:12]) {
		case "avif", "avis":
			return "image/avif"
		case "heic", "heix":
			return "image/heic"
		case "mif1":
			return "image/heif"
		}
	}
	return ct
}

// imageSize reads the size from the header of the image types the standard
// library cannot decode: WebP, BMP, AVIF and HEIC. It returns 0, 0 when it
// cannot tell.
func imageSize(b []byte) (w, h int) {
	le := binary.LittleEndian
	switch {
	case len(b) >= 30 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		switch string(b[12:16]) {
		case "VP8X":
			return 1 + int(b[24]) | int(b[25])<<8 | int(b[26])<<16, 1 + int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		case "VP8L":
			if bits := le.Uint32(b[21:25]); b[20] == 0x2f {
				return 1 + int(bits&0x3fff), 1 + int(bits>>14&0x3fff)
			}
		case "VP8 ":
			if string(b[23:26]) == "\x9d\x01\x2a" {
				return int(le.Uint16(b[26:28]) & 0x3fff), int(le.Uint16(b[28:30]) & 0x3fff)
			}
		}
	case len(b) >= 26 && string(b[:2]) == "BM":
		w, h := int32(le.Uint32(b[18:22])), int32(le.Uint32(b[22:26]))
		return int(w), int(max(h, -h)) // negative height means top-down rows
	case len(b) >= 12 && string(b[4:8]) == "ftyp":
		// ponytail: the largest "ispe" (image spatial extent) box wins, so a
		// grid image reports its full size, not a tile's. It is the coded
		// size; the clean-aperture crop (odd sizes) is ignored, so it can be
		// a pixel or two larger. Parse iprp/ipma properly if that matters.
		for i := bytes.Index(b, []byte("ispe")); i >= 0 && i+16 <= len(b); {
			bw, bh := int(binary.BigEndian.Uint32(b[i+8:])), int(binary.BigEndian.Uint32(b[i+12:]))
			if bw*bh > w*h && bw <= 1<<16 && bh <= 1<<16 {
				w, h = bw, bh
			}
			j := bytes.Index(b[i+4:], []byte("ispe"))
			if j < 0 {
				break
			}
			i += 4 + j
		}
	}
	return w, h
}

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
	ctype := sniffType(head[:n])
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
	if strings.HasPrefix(ctype, "image/") {
		// Photos carry GPS and camera details; every viewer would get them.
		b, err := os.ReadFile(tmp.Name())
		if out := stripMeta(b); err == nil && out != nil && len(out) <= len(b) {
			_, err = tmp.WriteAt(out, 0)
			err = cmp.Or(err, tmp.Truncate(int64(len(out))))
			rest = int64(len(out))
		}
		if err != nil {
			httpError(w, http.StatusInternalServerError, "cannot store file")
			return
		}
	}
	a := &v1.Attachment{Id: newID(s.now()), Name: name, ContentType: ctype, Size: rest}
	if strings.HasPrefix(ctype, "image/") {
		if _, err := tmp.Seek(0, io.SeekStart); err == nil {
			if cfg, _, err := image.DecodeConfig(tmp); err == nil {
				a.Width, a.Height = int32(cfg.Width), int32(cfg.Height)
			} else if _, err := tmp.Seek(0, io.SeekStart); err == nil {
				b, _ := io.ReadAll(io.LimitReader(tmp, 64<<10))
				w, h := imageSize(b)
				a.Width, a.Height = int32(w), int32(h)
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
	s.signURLs(a)
	body, _ := protojson.Marshal(a)
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// serveFile serves an upload to anyone with a valid signed URL.
// Uploaded content is untrusted: it never runs as a page on this origin.
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if !fileSigOK(s.fileKey, r.PathValue("id"), q.Get("exp"), q.Get("sig"), s.now()) {
		httpError(w, http.StatusForbidden, "file link is invalid or expired; reload the message for a new one")
		return
	}
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
