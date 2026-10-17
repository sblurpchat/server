package server

import (
	"bytes"
	"encoding/binary"
)

// stripMeta removes metadata from an image without re-encoding: EXIF (GPS,
// camera), XMP, IPTC, comments and text chunks, and anything after the end
// of the image. It keeps what affects how the image looks: JFIF, the ICC
// color profile, Adobe's color transform and, for JPEG, the EXIF orientation
// (rewritten as a minimal EXIF block). HEIC and AVIF keep their size: the
// Exif and XMP item bytes are zeroed in place. It returns nil for anything
// else or anything it cannot parse.
func stripMeta(b []byte) []byte {
	switch {
	case len(b) > 4 && b[0] == 0xff && b[1] == 0xd8:
		return stripJPEG(b)
	case len(b) > 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return stripPNG(b)
	case len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return stripWebP(b)
	case len(b) > 13 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		return stripGIF(b)
	case len(b) > 12 && string(b[4:8]) == "ftyp":
		return stripISOBMFF(b)
	}
	return nil
}

func stripJPEG(b []byte) []byte {
	out := []byte{0xff, 0xd8}
	orient := 0
	for i := 2; ; {
		if i+4 > len(b) || b[i] != 0xff {
			return nil
		}
		marker := b[i+1]
		if marker == 0xff { // fill byte
			i++
			continue
		}
		if marker == 0xd9 { // EOI: drop anything after it
			out = append(out, 0xff, 0xd9)
			if orient > 1 {
				out = append(out[:2], append(exifOrientation(orient), out[2:]...)...)
			}
			return out
		}
		end := i + 2 + int(binary.BigEndian.Uint16(b[i+2:]))
		if end > len(b) || end < i+4 {
			return nil
		}
		seg := b[i+4 : end]
		keep := true
		switch {
		case marker == 0xe1:
			if o := readOrientation(seg); o > 0 && orient == 0 {
				orient = o
			}
			keep = false
		case marker == 0xe2:
			keep = bytes.HasPrefix(seg, []byte("ICC_PROFILE\x00"))
		case marker == 0xee:
			keep = bytes.HasPrefix(seg, []byte("Adobe"))
		case marker > 0xe0 && marker <= 0xef, marker == 0xfe: // other APPn, COM
			keep = false
		}
		if keep {
			out = append(out, b[i:end]...)
		}
		i = end
		if marker != 0xda { // SOS: entropy-coded data follows
			continue
		}
		for ; i+1 < len(b); i++ {
			if b[i] == 0xff && b[i+1] != 0 && (b[i+1] < 0xd0 || b[i+1] > 0xd7) {
				break
			}
		}
		out = append(out, b[end:i]...)
	}
}

// readOrientation returns the Orientation tag (1-8) from an EXIF APP1
// payload, or 0.
func readOrientation(seg []byte) int {
	if !bytes.HasPrefix(seg, []byte("Exif\x00\x00")) || len(seg) < 14 {
		return 0
	}
	t := seg[6:]
	var o binary.ByteOrder = binary.BigEndian
	if string(t[:2]) == "II" {
		o = binary.LittleEndian
	}
	ifd := int(o.Uint32(t[4:]))
	if ifd+2 > len(t) || ifd < 8 {
		return 0
	}
	n := int(o.Uint16(t[ifd:]))
	for e := ifd + 2; e+12 <= len(t) && n > 0; e, n = e+12, n-1 {
		if o.Uint16(t[e:]) == 0x0112 {
			if v := int(o.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
		}
	}
	return 0
}

// exifOrientation is an APP1 segment holding only the Orientation tag.
func exifOrientation(v int) []byte {
	return []byte{0xff, 0xe1, 0, 34, 'E', 'x', 'i', 'f', 0, 0,
		'M', 'M', 0, 42, 0, 0, 0, 8, // TIFF header, IFD0 at 8
		0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(v), 0, 0, // one SHORT entry
		0, 0, 0, 0} // no next IFD
}

func stripPNG(b []byte) []byte {
	out := append([]byte(nil), b[:8]...)
	for i := 8; i+12 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[i:]))
		end := i + 12 + n
		if n < 0 || end > len(b) || end < i {
			return nil
		}
		switch string(b[i+4 : i+8]) {
		case "eXIf", "tEXt", "zTXt", "iTXt", "tIME":
		default:
			out = append(out, b[i:end]...)
		}
		if string(b[i+4:i+8]) == "IEND" {
			return out
		}
		i = end
	}
	return nil
}

// stripWebP drops the EXIF and XMP chunks, clears their VP8X flags and fixes
// the RIFF size. The ICCP color profile stays.
func stripWebP(b []byte) []byte {
	le := binary.LittleEndian
	n := int(le.Uint32(b[4:])) + 8
	if n > len(b) || n < 12 {
		return nil
	}
	out := append([]byte(nil), b[:12]...)
	vp8x := -1
	for i := 12; i < n; {
		if i+8 > n {
			return nil
		}
		sz := int(le.Uint32(b[i+4:]))
		if sz > n-i-8 {
			return nil
		}
		end := min(i+8+sz+sz&1, n) // chunks are padded to even length
		switch string(b[i : i+4]) {
		case "EXIF", "XMP ":
		case "VP8X":
			vp8x = len(out)
			fallthrough
		default:
			out = append(out, b[i:end]...)
		}
		i = end
	}
	if vp8x >= 0 && vp8x+9 <= len(out) {
		out[vp8x+8] &^= 0x0c // EXIF and XMP present flags
	}
	le.PutUint32(out[4:], uint32(len(out)-8))
	return out
}

// stripGIF drops comment and application extensions, except the NETSCAPE2.0
// block that makes an animation loop, and anything after the trailer.
func stripGIF(b []byte) []byte {
	i := 13
	if b[10]&0x80 != 0 { // global color table
		i += 3 << (b[10]&7 + 1)
	}
	if i > len(b) {
		return nil
	}
	out := append([]byte(nil), b[:i]...)
	subBlocks := func(i int) int { // end of a run of sub-blocks, or -1
		for i < len(b) {
			if b[i] == 0 {
				return i + 1
			}
			i += 1 + int(b[i])
		}
		return -1
	}
	for i < len(b) {
		end := -1
		switch b[i] {
		case 0x3b: // trailer
			return append(out, 0x3b)
		case 0x2c: // image descriptor, optional local color table, LZW data
			if i+11 > len(b) {
				return nil
			}
			j := i + 10
			if b[i+9]&0x80 != 0 {
				j += 3 << (b[i+9]&7 + 1)
			}
			end = subBlocks(j + 1)
		case 0x21: // extension
			if i+2 > len(b) {
				return nil
			}
			end = subBlocks(i + 2)
			if end < 0 {
				return nil
			}
			label := b[i+1]
			if label == 0xfe || label == 0xff && !bytes.HasPrefix(b[i+2:end], []byte("\x0bNETSCAPE2.0")) {
				i = end
				continue
			}
		}
		if end < 0 {
			return nil
		}
		out = append(out, b[i:end]...)
		i = end
	}
	return nil
}

// stripISOBMFF zeroes the data of the Exif and mime (XMP) items of a HEIC or
// AVIF in place, so every offset in the file stays valid. Orientation (irot,
// imir) and the color profile (colr) are item properties and stay.
// ponytail: the empty item entries stay in iinf/iloc; rewrite the box tables
// if a reader ever chokes on a zeroed Exif item.
func stripISOBMFF(b []byte) []byte {
	out := bytes.Clone(b)
	var meta []byte
	if !eachBox(out, func(typ string, body []byte) {
		if typ == "meta" && meta == nil {
			meta = body
		}
	}) || len(meta) < 4 {
		return nil
	}
	var iinf, iloc, idat []byte
	if !eachBox(meta[4:], func(typ string, body []byte) {
		switch typ {
		case "iinf":
			iinf = body
		case "iloc":
			iloc = body
		case "idat":
			idat = body
		}
	}) || len(iinf) < 6 {
		return nil
	}
	blank := map[uint64]bool{}
	p := 6
	if iinf[0] > 0 {
		p = 8
	}
	if p > len(iinf) || !eachBox(iinf[p:], func(typ string, e []byte) {
		if typ != "infe" || len(e) < 12 || e[0] < 2 {
			return
		}
		id, t := uint64(binary.BigEndian.Uint16(e[4:])), 8
		if e[0] > 2 {
			id, t = uint64(binary.BigEndian.Uint32(e[4:])), 10
		}
		if t+4 <= len(e) && (string(e[t:t+4]) == "Exif" || string(e[t:t+4]) == "mime") {
			blank[id] = true
		}
	}) || len(blank) == 0 {
		return nil
	}
	pos, bad := 0, false
	read := func(n uint64) (v uint64) {
		if pos+int(n) > len(iloc) {
			bad = true
			return 0
		}
		for _, c := range iloc[pos : pos+int(n)] {
			v = v<<8 | uint64(c)
		}
		pos += int(n)
		return v
	}
	v := read(1)
	read(3)
	sizes, sizes2 := read(1), read(1)
	idxSize, wide := uint64(0), uint64(2)
	if v == 1 || v == 2 {
		idxSize = sizes2 & 15
	}
	if v == 2 {
		wide = 4
	}
	cleared := 0
	for n := read(wide); n > 0 && !bad; n-- {
		id, method := read(wide), uint64(0)
		if v == 1 || v == 2 {
			method = read(2) & 15
		}
		read(2) // data reference index
		base := read(sizes2 >> 4)
		for ext := read(2); ext > 0 && !bad; ext-- {
			read(idxSize)
			off, length := read(sizes>>4), read(sizes&15)
			if !blank[id] {
				continue
			}
			src := out
			if method == 1 {
				src = idat
			} else if method != 0 {
				return nil
			}
			start := base + off
			if length == 0 || start < base || start > uint64(len(src)) || length > uint64(len(src))-start {
				return nil
			}
			clear(src[start : start+length])
			cleared++
		}
	}
	if bad || cleared == 0 {
		return nil
	}
	return out
}

// eachBox calls f for each ISOBMFF box in b and reports whether b parsed.
func eachBox(b []byte, f func(typ string, body []byte)) bool {
	for len(b) > 0 {
		if len(b) < 8 {
			return false
		}
		n, h := uint64(binary.BigEndian.Uint32(b)), uint64(8)
		switch n {
		case 0: // to the end
			n = uint64(len(b))
		case 1: // 64-bit size
			if len(b) < 16 {
				return false
			}
			n, h = binary.BigEndian.Uint64(b[8:]), 16
		}
		if n < h || n > uint64(len(b)) {
			return false
		}
		f(string(b[4:8]), b[h:n])
		b = b[n:]
	}
	return true
}
