package server

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Uploads lose EXIF, comments and text chunks but keep color and
// orientation (1037).
func TestUploadStripsMetadata(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	stored := func(name string, body []byte) []byte {
		t.Helper()
		_, a := ana.upload(name, body)
		if a == nil {
			t.Fatalf("upload %s failed", name)
		}
		got, err := os.ReadFile(filepath.Join(e.dir, "files", a.Id))
		if err != nil {
			t.Fatal(err)
		}
		if a.Size != int64(len(got)) || a.Width != 4 || a.Height != 3 {
			t.Fatalf("%s: attachment %v, stored %d bytes", name, a, len(got))
		}
		if _, err := png.Decode(bytes.NewReader(got)); name == "a.png" && err != nil {
			t.Fatalf("stripped png does not decode: %v", err)
		}
		return got
	}
	le := binary.LittleEndian
	exif := []byte("Exif\x00\x00II*\x00")
	exif = le.AppendUint32(exif, 8)
	exif = le.AppendUint16(exif, 2)
	exif = append(le.AppendUint16(le.AppendUint16(exif, 0x010f), 2), 12, 0, 0, 0, 38, 0, 0, 0) // Make -> string
	exif = append(le.AppendUint16(le.AppendUint16(exif, 0x0112), 3), 1, 0, 0, 0, 6, 0, 0, 0)   // Orientation 6
	exif = append(exif, 0, 0, 0, 0)
	exif = append(exif, "GPS 37.7749N"...)
	seg := func(marker byte, p []byte) []byte {
		return append([]byte{0xff, marker, byte((len(p) + 2) >> 8), byte(len(p) + 2)}, p...)
	}
	var jb bytes.Buffer
	jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 4, 3)), nil)
	j := jb.Bytes()
	in := append([]byte{0xff, 0xd8}, seg(0xe1, exif)...)
	in = append(in, seg(0xe2, []byte("ICC_PROFILE\x00\x01\x01fakeprofile"))...)
	in = append(in, seg(0xfe, []byte("secret comment"))...)
	in = append(in, j[2:]...)
	in = append(in, "TRAILER-SECRET"...)
	got := stored("a.jpg", in)
	for _, s := range []string{"GPS 37.7749N", "secret comment", "TRAILER-SECRET"} {
		if bytes.Contains(got, []byte(s)) {
			t.Errorf("jpeg still holds %q", s)
		}
	}
	if !bytes.Contains(got, []byte("ICC_PROFILE")) || !bytes.Contains(got, []byte{0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6}) {
		t.Errorf("jpeg lost its color profile or orientation")
	}
	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("stripped jpeg does not decode: %v", err)
	}

	p := pngBytes(4, 3)
	chunk := func(typ, data string) []byte {
		c := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
		c = append(c, typ+data...)
		return binary.BigEndian.AppendUint32(c, crc32.ChecksumIEEE([]byte(typ+data)))
	}
	iend := len(p) - 12
	pin := append(append([]byte{}, p[:iend]...), chunk("tEXt", "GPS\x0037.7749N")...)
	pin = append(pin, chunk("eXIf", "MM\x00*camera-serial")...)
	pin = append(pin, p[iend:]...)
	got = stored("a.png", pin)
	if bytes.Contains(got, []byte("37.7749N")) || bytes.Contains(got, []byte("camera-serial")) || !bytes.Equal(got, p) {
		t.Errorf("png not stripped: %d bytes, want %d", len(got), len(p))
	}
}

// WebP, GIF, HEIC and AVIF lose EXIF, XMP and comments; color profile,
// orientation and looping stay (1049).
func TestUploadStripsMetadataMoreFormats(t *testing.T) {
	e := newEnv(t)
	ana := e.join("ana")
	stored := func(name string, body []byte) []byte {
		t.Helper()
		_, a := ana.upload(name, body)
		if a == nil {
			t.Fatalf("upload %s failed", name)
		}
		got, err := os.ReadFile(filepath.Join(e.dir, "files", a.Id))
		if err != nil {
			t.Fatal(err)
		}
		if a.Size != int64(len(got)) || a.Width != 4 || a.Height != 3 {
			t.Fatalf("%s: attachment %v, stored %d bytes", name, a, len(got))
		}
		return got
	}
	le, be := binary.LittleEndian, binary.BigEndian

	// WebP: VP8X (ICC, EXIF and XMP flags), ICCP, VP8L, EXIF, XMP (odd, padded).
	riff := func(chunks ...string) []byte {
		b := append([]byte("RIFF\x00\x00\x00\x00WEBP"), strings.Join(chunks, "")...)
		le.PutUint32(b[4:], uint32(len(b)-8))
		return b
	}
	chunk := func(typ, data string) string {
		c := typ + string(le.AppendUint32(nil, uint32(len(data)))) + data
		if len(data)%2 == 1 {
			c += "\x00"
		}
		return c
	}
	vp8x := func(flags byte) string { return chunk("VP8X", string([]byte{flags, 0, 0, 0, 3, 0, 0, 2, 0, 0})) }
	keep := []string{chunk("ICCP", "fakeprofile"), chunk("VP8L", "\x2f\x03\xc0\x00\x00pixels")}
	in := riff(append(append([]string{vp8x(0x2c)}, keep...), chunk("EXIF", "MM\x00*GPS 37.7749N"), chunk("XMP ", "<x:xmpmeta>secret</x:xmpmeta>!"))...)
	want := riff(append([]string{vp8x(0x20)}, keep...)...)
	if got := stored("a.webp", append(in, "TRAILER"...)); !bytes.Equal(got, want) {
		t.Errorf("webp not stripped:\n got %q\nwant %q", got, want)
	}

	// GIF: a comment and an XMP application extension before NETSCAPE2.0.
	g := gifBytes(4, 3)
	at := bytes.Index(g, []byte("\x21\xff\x0bNETSCAPE2.0"))
	if at < 0 {
		t.Fatal("gif fixture has no loop block")
	}
	gin := append(append([]byte{}, g[:at]...), "\x21\xfe\x0aGPS secret\x00\x21\xff\x0bXMP DataXMP\x08secretxm\x00"...)
	gin = append(append(gin, g[at:]...), "TRAILER"...)
	if got := stored("a.gif", gin); !bytes.Equal(got, g) {
		t.Errorf("gif not stripped:\n got %q\nwant %q", got, g)
	}

	// HEIC/AVIF: Exif and XMP items in mdat and idat; irot and colr stay.
	box := func(typ string, parts ...string) string {
		body := strings.Join(parts, "")
		return string(be.AppendUint32(nil, uint32(8+len(body)))) + typ + body
	}
	u16 := func(v int) string { return string(be.AppendUint16(nil, uint16(v))) }
	u32 := func(v int) string { return string(be.AppendUint32(nil, uint32(v))) }
	exif := "\x00\x00\x00\x06Exif\x00\x00MM\x00*GPS 37.7749N"
	xmp := "<x:xmpmeta>secret</x:xmpmeta>"
	heif := func(brand string, mdat int) []byte {
		infe := func(id int, typ, extra string) string {
			return box("infe", "\x02\x00\x00\x00", u16(id), u16(0), typ, "\x00", extra)
		}
		loc := func(id, method, off, n int) string {
			return u16(id) + u16(method) + u16(0) + u16(1) + u32(off) + u32(n)
		}
		meta := box("meta", "\x00\x00\x00\x00",
			box("iinf", "\x00\x00\x00\x00", u16(3), infe(1, "hvc1", ""), infe(2, "Exif", ""), infe(3, "mime", "application/rdf+xml\x00")),
			box("iloc", "\x01\x00\x00\x00\x44\x00", u16(3), loc(1, 0, mdat+8, 8), loc(2, 0, mdat+16, len(exif)), loc(3, 1, 0, len(xmp))),
			box("idat", xmp),
			box("iprp", box("ipco", box("ispe", "\x00\x00\x00\x00", u32(4), u32(3)), box("irot", "\x03"), box("colr", "prof"))))
		return []byte(box("ftyp", brand, "\x00\x00\x00\x00mif1") + meta + box("mdat", "HEVCDATA", exif))
	}
	for _, brand := range []string{"heic", "avif"} {
		probe := heif(brand, 0)
		hin := heif(brand, len(probe)-8-8-len(exif))
		got := stored("a."+brand, hin)
		if len(got) != len(hin) || bytes.Contains(got, []byte("37.7749N")) || bytes.Contains(got, []byte("secret")) {
			t.Errorf("%s not stripped: %q", brand, got)
		}
		for _, s := range []string{"HEVCDATA", "irot\x03", "colrprof", "application/rdf+xml"} {
			if !bytes.Contains(got, []byte(s)) {
				t.Errorf("%s lost %q", brand, s)
			}
		}
	}
}
