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
