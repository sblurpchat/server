package server

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"io"
	"mime/multipart"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestEmojiName(t *testing.T) {
	for in, want := range map[string]string{
		"parrot.gif":                     "parrot",
		"pack/Party Parrot.GIF":          "party_parrot",
		`C:\emoji\thumbs-up.png`:         "thumbs-up",
		":blob_cat:.webp":                "blob_cat",
		"  héllo wörld .png":             "h_llo_w_rld",
		"日本.png":                         "",
		".png":                           "png",
		strings.Repeat("a", 70) + ".png": strings.Repeat("a", 64),
	} {
		if got := emojiName(in); got != want {
			t.Errorf("emojiName(%q) = %q, want %q", in, got, want)
		}
	}
}

// webp is a minimal VP8X header: enough for the type sniff and the size.
func webp(w, h int) []byte {
	b := make([]byte, 30)
	copy(b, "RIFF\x16\x00\x00\x00WEBPVP8X")
	b[24], b[25], b[26] = byte(w-1), byte((w-1)>>8), 0
	b[27], b[28], b[29] = byte(h-1), byte((h-1)>>8), 0
	return b
}

func gifBytes(w, h int) []byte {
	var buf bytes.Buffer
	p := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{p, p}, Delay: []int{10, 10}})
	return buf.Bytes()
}

func TestCheckEmojiImage(t *testing.T) {
	ok := map[string][]byte{"image/png": pngBytes(64, 64), "image/gif": gifBytes(128, 32), "image/webp": webp(512, 512)}
	for want, b := range ok {
		if got, err := checkEmojiImage(b); err != nil || got != want {
			t.Errorf("%s: got %q, %v", want, got, err)
		}
	}
	bad := map[string][]byte{
		"larger than": append(pngBytes(8, 8), make([]byte, maxEmojiBytes)...),
		"not a PNG":   []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"),
		"513x16":      pngBytes(513, 16),
		"16x600":      webp(16, 600),
		"cannot read": []byte("\x89PNG\r\n\x1a\n garbage"),
	}
	for want, b := range bad {
		if _, err := checkEmojiImage(b); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("want error with %q, got %v", want, err)
		}
	}
}

type upFile struct {
	name string
	body []byte
}

func (c *client) uploadEmoji(files ...upFile) (int, []*v1.EmojiUploadResult) {
	c.e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, f := range files {
		fw, _ := mw.CreateFormFile("file", f.name)
		fw.Write(f.body)
	}
	mw.Close()
	req, _ := http.NewRequest("POST", c.e.url+"/emoji", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := c.httpc.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		return res.StatusCode, nil
	}
	out := &v1.UploadEmojiResponse{}
	if err := protojson.Unmarshal(data, out); err != nil {
		c.e.t.Fatal(err)
	}
	return 200, out.Results
}

func (c *client) get(path string, header ...string) (*http.Response, []byte) {
	c.e.t.Helper()
	req, _ := http.NewRequest("GET", c.e.url+path, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	// A bare transport: http.Client would gunzip and hide Content-Encoding.
	res, err := c.httpc.Transport.RoundTrip(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, b
}

func (c *client) emojiList() (etag string, names []string, urls map[string]string) {
	c.e.t.Helper()
	res, b := c.get("/emoji")
	if res.StatusCode != 200 {
		c.e.t.Fatalf("GET /emoji: %d %s", res.StatusCode, b)
	}
	out := &v1.ListEmojiResponse{}
	if err := protojson.Unmarshal(b, out); err != nil {
		c.e.t.Fatal(err)
	}
	urls = map[string]string{}
	for _, e := range out.Emoji {
		names = append(names, e.Name)
		urls[e.Name] = e.Url
	}
	return res.Header.Get("ETag"), names, urls
}

func statuses(rs []*v1.EmojiUploadResult) string {
	var s []string
	for _, r := range rs {
		s = append(s, r.Name+"="+strings.ToLower(strings.TrimPrefix(r.Status.String(), "EMOJI_UPLOAD_STATUS_")))
	}
	return strings.Join(s, " ")
}

func TestEmojiUploadListAndETag(t *testing.T) {
	e := newEnv(t)
	ana, bob, cy := e.join("ana"), e.join("bob"), e.join("cy")
	if err := ana.setRole(cy.me.Id, v1.MemberRole_MEMBER_ROLE_MODERATOR); err != nil {
		t.Fatal(err)
	}
	if code, _ := bob.uploadEmoji(upFile{"wave.png", pngBytes(16, 16)}); code != http.StatusForbidden {
		t.Fatalf("member upload: %d", code)
	}
	if code, _ := e.client(e.token("stranger")).uploadEmoji(upFile{"wave.png", pngBytes(16, 16)}); code != http.StatusForbidden {
		t.Fatalf("non-member upload: %d", code)
	}
	if res, _ := e.client("").get("/emoji"); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous list: %d", res.StatusCode)
	}

	etag0, names, _ := bob.emojiList()
	if len(names) != 0 {
		t.Fatalf("new server has emoji: %v", names)
	}
	sub := bob.subscribe(bob.state().Seq)
	code, rs := cy.uploadEmoji(upFile{"Wave.png", pngBytes(16, 16)}, upFile{"dance.gif", gifBytes(32, 32)},
		upFile{"notes.txt", []byte("hello")}, upFile{"wave.webp", webp(16, 16)})
	if code != 200 || statuses(rs) != "wave=added dance=added notes=rejected wave=exists" {
		t.Fatalf("upload: %d %s", code, statuses(rs))
	}
	if rs[2].Error == "" {
		t.Fatal("rejected file has no reason")
	}
	sub.next(func(ev *v1.Event) bool { return ev.GetEmojiChanged() }, nil)

	etag1, names, urls := bob.emojiList()
	if !slices.Equal(names, []string{"dance", "wave"}) || etag1 == etag0 {
		t.Fatalf("list %v etag %q (was %q)", names, etag1, etag0)
	}
	if res, _ := bob.get("/emoji", "If-None-Match", etag1); res.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidate: %d", res.StatusCode)
	}
	res, gz := bob.get("/emoji", "Accept-Encoding", "gzip")
	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("list is not gzipped")
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	if plain, _ := io.ReadAll(zr); !bytes.Contains(plain, []byte(`"dance"`)) {
		t.Fatalf("gzipped list: %s", plain)
	}

	res, img := e.client("").get(urls["dance"])
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/gif" || !bytes.Equal(img, gifBytes(32, 32)) ||
		!strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("image: %d %v", res.StatusCode, res.Header)
	}

	// Delete: moderators and up only, and the old ETag stops matching.
	_, err = bob.srv.DeleteEmoji(ctx(), connect.NewRequest(&v1.DeleteEmojiRequest{Name: "wave"}))
	wantCode(t, err, connect.CodePermissionDenied)
	must(cy.srv.DeleteEmoji(ctx(), connect.NewRequest(&v1.DeleteEmojiRequest{Name: "wave"})))
	_, err = cy.srv.DeleteEmoji(ctx(), connect.NewRequest(&v1.DeleteEmojiRequest{Name: "wave"}))
	wantCode(t, err, connect.CodeNotFound)
	if res, _ := bob.get("/emoji", "If-None-Match", etag1); res.StatusCode != 200 {
		t.Fatalf("stale ETag still matches: %d", res.StatusCode)
	}
	if _, names, _ := bob.emojiList(); !slices.Equal(names, []string{"dance"}) {
		t.Fatalf("after delete: %v", names)
	}
	if res, _ := bob.get(urls["wave"]); res.StatusCode != http.StatusNotFound {
		t.Fatalf("deleted image: %d", res.StatusCode)
	}
	// Re-adding the name gets a new URL, so a cached image never goes stale.
	cy.uploadEmoji(upFile{"wave.png", pngBytes(20, 20)})
	if _, _, u := bob.emojiList(); u["wave"] == urls["wave"] {
		t.Fatalf("re-added emoji reuses %s", u["wave"])
	}
}

func zipOf(t *testing.T, files ...upFile) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(f.body)
	}
	zw.Close()
	return buf.Bytes()
}

func TestEmojiZipImportExportRoundTrip(t *testing.T) {
	a, b := newEnv(t), newEnv(t)
	ana, bea := a.join("ana"), b.join("bea")
	pack := zipOf(t,
		upFile{"pack/", nil},
		upFile{"pack/Party Parrot.gif", gifBytes(32, 32)},
		upFile{"pack/sub/blobcat.png", pngBytes(48, 48)},
		upFile{"pack/fast.webp", webp(64, 64)},
		upFile{"__MACOSX/pack/._blobcat.png", []byte("junk")},
		upFile{"pack/.DS_Store", []byte("junk")},
		upFile{"pack/huge.png", pngBytes(1024, 1024)},
	)
	code, rs := ana.uploadEmoji(upFile{"slackmoji.zip", pack})
	if code != 200 || statuses(rs) != "party_parrot=added blobcat=added fast=added huge=rejected" {
		t.Fatalf("zip import: %d %s", code, statuses(rs))
	}
	if rs[0].File != "slackmoji.zip/pack/Party Parrot.gif" {
		t.Fatalf("file path in result: %q", rs[0].File)
	}

	res, export := ana.get("/emoji.zip")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("export: %d", res.StatusCode)
	}
	zr, err := zip.NewReader(bytes.NewReader(export), int64(len(export)))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range zr.File {
		got = append(got, f.Name)
	}
	if !slices.Equal(got, []string{"blobcat.png", "fast.webp", "party_parrot.gif"}) {
		t.Fatalf("export files: %v", got)
	}

	code, rs = bea.uploadEmoji(upFile{"emoji.zip", export})
	if code != 200 || statuses(rs) != "blobcat=added fast=added party_parrot=added" {
		t.Fatalf("round trip import: %d %s", code, statuses(rs))
	}
	_, _, aURLs := ana.emojiList()
	_, _, bURLs := bea.emojiList()
	for name := range aURLs {
		_, x := ana.get(aURLs[name])
		_, y := bea.get(bURLs[name])
		if len(x) == 0 || !bytes.Equal(x, y) {
			t.Fatalf("%s differs after the round trip", name)
		}
	}
	if code, rs := bea.uploadEmoji(upFile{"bad.zip", []byte("PK\x03\x04 not really")}); code != 200 || rs[0].Status != v1.EmojiUploadStatus_EMOJI_UPLOAD_STATUS_REJECTED {
		t.Fatalf("broken zip: %d %v", code, rs)
	}
}

// Thousands of emoji must stay one small, cheap response.
func TestEmojiList5000(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	img := pngBytes(32, 32)
	err := e.s.writeTx(ctx(), func(tx *wtx) error {
		for i := range 5000 {
			if _, err := tx.ExecContext(ctx(), "INSERT INTO emoji(name, content_type, created_by, created_at_ms, data) VALUES (?,?,?,?,?)",
				fmt.Sprintf("emoji_name_%04d", i), "image/png", ana.me.Id, 0, img); err != nil {
				return err
			}
		}
		return emojiChanged(tx)
	})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	res, body := ana.get("/emoji", "Accept-Encoding", "gzip")
	cold := time.Since(start)
	start = time.Now()
	ana.get("/emoji", "Accept-Encoding", "gzip")
	warm := time.Since(start)
	start = time.Now()
	res304, _ := ana.get("/emoji", "If-None-Match", res.Header.Get("ETag"))
	reval := time.Since(start)
	_, plain := ana.get("/emoji")
	t.Logf("5000 emoji: %d bytes gzipped, %d plain; first %v, cached %v, revalidate %d in %v", len(body), len(plain), cold, warm, res304.StatusCode, reval)
	if res304.StatusCode != http.StatusNotModified || len(body) > 64<<10 {
		t.Fatalf("revalidate %d, gzipped size %d", res304.StatusCode, len(body))
	}
}
