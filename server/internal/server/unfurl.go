package server

import (
	"cmp"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Link previews (1110). The server fetches the page, never the browser: no
// CORS, and viewers' IPs stay hidden. Pages and their og:image are fetched
// once, cached in link_previews, and the image is served from /unfurl/{id}.

const (
	unfurlUA       = "Mozilla/5.0 (compatible; Sblurpbot/1.0; +https://sblurp.chat/docs/bots; like Discordbot and Twitterbot)"
	unfurlTimeout  = 5 * time.Second
	unfurlMaxHTML  = 512 << 10
	unfurlMaxImage = 2 << 20
	unfurlMaxLinks = 5
	unfurlTTL      = 24 * time.Hour
	unfurlFailTTL  = time.Hour
)

type unfurler struct {
	allow    func(netip.AddrPort) bool // nil = publicAddr; tests override it
	once     sync.Once
	client   *http.Client
	mu       sync.Mutex
	inflight map[string]chan struct{}
}

var errBlocked = errors.New("address not allowed")

// httpClient checks the address it actually connects to, for the first
// request and every redirect, so DNS tricks and redirects to 127.0.0.1 fail.
func (u *unfurler) httpClient() *http.Client {
	u.once.Do(func() {
		allow := u.allow
		if allow == nil {
			allow = publicAddr
		}
		d := &net.Dialer{Timeout: unfurlTimeout, Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !allow(ap) {
				return errBlocked
			}
			return nil
		}}
		u.client = &http.Client{
			Timeout: unfurlTimeout,
			Transport: &http.Transport{
				DialContext:            d.DialContext,
				TLSHandshakeTimeout:    unfurlTimeout,
				MaxResponseHeaderBytes: 64 << 10,
			},
			CheckRedirect: func(r *http.Request, via []*http.Request) error {
				if len(via) > 3 {
					return errors.New("too many redirects")
				}
				if r.URL.Scheme != "http" && r.URL.Scheme != "https" {
					return errBlocked
				}
				return nil
			},
		}
	})
	return u.client
}

var blockedNets = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "fec0::/10",
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// publicAddr allows only ports 80 and 443 on public unicast addresses.
func publicAddr(ap netip.AddrPort) bool {
	if p := ap.Port(); p != 80 && p != 443 {
		return false
	}
	ip := ap.Addr()
	if ip.Is4In6() || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range blockedNets {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// normalizeURL is the cache key: http(s) only, no user info, lower-case
// host, no default port, no fragment.
func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Hostname() == "" {
		return "", errBlocked
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	if port != "" {
		u.Host += ":" + port
	}
	u.Fragment, u.RawFragment = "", ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}

var (
	codeRe = regexp.MustCompile("(?s)```.*?```|`[^`\n]+`")
	linkRe = regexp.MustCompile(`https?://[^\s<]*[^\s<.,:;"')\]!?]`) // same as the web client's
)

// linksIn returns the http(s) links to preview in a message, each once,
// at most unfurlMaxLinks. Links in code are not links.
func linksIn(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, l := range linkRe.FindAllString(codeRe.ReplaceAllString(text, " "), -1) {
		k, err := normalizeURL(l)
		if err != nil || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, l)
		if len(out) == unfurlMaxLinks {
			break
		}
	}
	return out
}

type pageMeta struct{ title, description, siteName, image string }

// parseHead reads Open Graph, Twitter card, <title> and meta description
// from the head of an HTML page. It stops at </head> or <body>.
func parseHead(doc string) pageMeta {
	lower := asciiLower(doc)
	meta := map[string]string{}
	title := ""
	for i := 0; ; {
		j := strings.IndexByte(doc[i:], '<')
		if j < 0 {
			break
		}
		i += j
		if strings.HasPrefix(doc[i:], "<!--") {
			k := strings.Index(doc[i:], "-->")
			if k < 0 {
				break
			}
			i += k + 3
			continue
		}
		k := i + 1
		closing := k < len(doc) && doc[k] == '/'
		if closing {
			k++
		}
		n := k
		for n < len(doc) && (doc[n] >= 'a' && doc[n] <= 'z' || doc[n] >= 'A' && doc[n] <= 'Z' || doc[n] >= '0' && doc[n] <= '9') {
			n++
		}
		name := lower[k:n]
		if name == "" {
			i++
			continue
		}
		end, attrs := scanAttrs(doc, n)
		if end < 0 || name == "body" || (closing && name == "head") {
			break
		}
		if !closing {
			switch name {
			case "meta":
				key := strings.ToLower(attrs["property"])
				if key == "" {
					key = strings.ToLower(attrs["name"])
				}
				if _, ok := meta[key]; key != "" && !ok {
					meta[key] = attrs["content"]
				}
			case "title", "script", "style", "noscript", "template":
				c := strings.Index(lower[end:], "</"+name)
				if c < 0 {
					c = len(doc) - end
				}
				if name == "title" && title == "" {
					title = html.UnescapeString(doc[end : end+c])
				}
				end += c
			}
		}
		i = end
	}
	first := func(keys ...string) string {
		for _, k := range keys {
			if v := clean(meta[k]); v != "" {
				return v
			}
		}
		return ""
	}
	return pageMeta{
		title:       clip(cmp.Or(first("og:title", "twitter:title"), clean(title)), 200),
		description: clip(first("og:description", "twitter:description", "description"), 300),
		siteName:    clip(first("og:site_name", "application-name"), 80),
		image:       first("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"),
	}
}

// scanAttrs reads a tag's attributes from i to its '>'. It returns the
// index after '>', or -1 if the tag never ends.
func scanAttrs(doc string, i int) (int, map[string]string) {
	attrs := map[string]string{}
	isSpace := func(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }
	for i < len(doc) {
		c := doc[i]
		switch {
		case c == '>':
			return i + 1, attrs
		case isSpace(c) || c == '/':
			i++
			continue
		}
		n := i
		for i < len(doc) && !isSpace(doc[i]) && doc[i] != '=' && doc[i] != '>' && doc[i] != '/' {
			i++
		}
		name := strings.ToLower(doc[n:i])
		for i < len(doc) && isSpace(doc[i]) {
			i++
		}
		val := ""
		if i < len(doc) && doc[i] == '=' {
			i++
			for i < len(doc) && isSpace(doc[i]) {
				i++
			}
			if i < len(doc) && (doc[i] == '"' || doc[i] == '\'') {
				q := doc[i]
				k := strings.IndexByte(doc[i+1:], q)
				if k < 0 {
					return -1, nil
				}
				val = doc[i+1 : i+1+k]
				i += k + 2
			} else {
				n := i
				for i < len(doc) && !isSpace(doc[i]) && doc[i] != '>' {
					i++
				}
				val = doc[n:i]
			}
		}
		if _, ok := attrs[name]; !ok {
			attrs[name] = html.UnescapeString(val)
		}
	}
	return -1, nil
}

// asciiLower keeps byte offsets, unlike strings.ToLower.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func clean(s string) string { return strings.Join(strings.Fields(s), " ") }

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n-1])) + "…"
}

type linkPreview struct {
	ok                           bool
	title, description, siteName string
	imageType                    string
	image                        []byte
}

// fetchPreview fetches a page and its image. It never returns an error:
// a failure is a preview with ok false, cached for less time.
func (u *unfurler) fetchPreview(key string) linkPreview {
	ctx, cancel := context.WithTimeout(context.Background(), unfurlTimeout)
	defer cancel()
	body, final, ctype, err := u.get(ctx, key, "text/html,application/xhtml+xml", unfurlMaxHTML, false)
	if err != nil {
		return linkPreview{}
	}
	if mt, _, _ := mime.ParseMediaType(ctype); mt != "text/html" && mt != "application/xhtml+xml" {
		return linkPreview{}
	}
	// ponytail: assumes UTF-8; other charsets show replacement characters. Decode by charset if it matters.
	m := parseHead(strings.ToValidUTF8(string(body), "�"))
	if m.title == "" {
		return linkPreview{}
	}
	p := linkPreview{ok: true, title: m.title, description: m.description, siteName: m.siteName}
	if p.siteName == "" {
		p.siteName = strings.TrimPrefix(final.Hostname(), "www.")
	}
	if ref, err := final.Parse(m.image); err == nil && m.image != "" && (ref.Scheme == "http" || ref.Scheme == "https") {
		ictx, cancel := context.WithTimeout(context.Background(), unfurlTimeout)
		defer cancel()
		if img, _, _, err := u.get(ictx, ref.String(), "image/*", unfurlMaxImage, true); err == nil {
			switch t := sniffType(img); t {
			case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif":
				p.imageType, p.image = t, img
			}
		}
	}
	return p
}

// get fetches u with the guarded client. Past max bytes it truncates the
// body, or fails when exact is set.
func (u *unfurler) get(ctx context.Context, target, accept string, max int64, exact bool) ([]byte, *url.URL, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, "", err
	}
	req.Header.Set("User-Agent", unfurlUA)
	req.Header.Set("Accept", accept)
	req.Header.Set("Accept-Language", "en")
	res, err := u.httpClient().Do(req)
	if err != nil {
		return nil, nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, nil, "", errors.New(res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if err != nil {
		return nil, nil, "", err
	}
	if int64(len(b)) > max {
		if exact {
			return nil, nil, "", errors.New("too big")
		}
		b = b[:max]
	}
	return b, res.Request.URL, res.Header.Get("Content-Type"), nil
}

func unfurlID(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:16])
}

// linkPreview returns the cached preview for a link, fetching it when it is
// missing or stale. Concurrent callers for one link share one fetch.
func (s *Server) linkPreview(raw string) *v1.LinkPreview {
	key, err := normalizeURL(raw)
	if err != nil {
		return nil
	}
	for {
		if p, fresh := s.cachedPreview(key); fresh {
			return p
		}
		u := &s.unfurl
		u.mu.Lock()
		if wait, busy := u.inflight[key]; busy {
			u.mu.Unlock()
			<-wait
			continue // the leader has stored it
		}
		// A leader may have stored it and left between the check above and the lock.
		if p, fresh := s.cachedPreview(key); fresh {
			u.mu.Unlock()
			return p
		}
		if u.inflight == nil {
			u.inflight = map[string]chan struct{}{}
		}
		done := make(chan struct{})
		u.inflight[key] = done
		u.mu.Unlock()

		p := u.fetchPreview(key)
		now := s.nowMs()
		err := s.writeTx(context.Background(), func(t *wtx) error {
			// ponytail: stale rows are cleared on each write; a sweep in pruneLoop if this ever shows up in profiles.
			if _, err := t.ExecContext(t.ctx, "DELETE FROM link_previews WHERE fetched_at_ms < ?", now-unfurlTTL.Milliseconds()); err != nil {
				return err
			}
			_, err := t.ExecContext(t.ctx, `INSERT OR REPLACE INTO link_previews(url, id, ok, title, description, site_name, image_type, image, fetched_at_ms)
				VALUES (?,?,?,?,?,?,?,?,?)`, key, unfurlID(key), p.ok, p.title, p.description, p.siteName, p.imageType, p.image, now)
			return err
		})
		u.mu.Lock()
		delete(u.inflight, key)
		u.mu.Unlock()
		close(done)
		if err != nil {
			s.log.Error("store link preview", "err", err)
			return nil
		}
		if !p.ok {
			return nil
		}
		return &v1.LinkPreview{Title: p.title, Description: p.description, SiteName: p.siteName, ImageUrl: imageURL(key, p.imageType)}
	}
}

func imageURL(key, imageType string) string {
	if imageType == "" {
		return ""
	}
	return "/unfurl/" + unfurlID(key)
}

// cachedPreview returns the stored preview (nil for a cached failure) and
// whether it is still fresh.
func (s *Server) cachedPreview(key string) (*v1.LinkPreview, bool) {
	var ok bool
	var at int64
	p := &v1.LinkPreview{}
	var imageType string
	err := s.db.r.QueryRow("SELECT ok, title, description, site_name, image_type, fetched_at_ms FROM link_previews WHERE url = ?", key).
		Scan(&ok, &p.Title, &p.Description, &p.SiteName, &imageType, &at)
	if err != nil {
		return nil, false
	}
	ttl := unfurlFailTTL
	if ok {
		ttl = unfurlTTL
	}
	if s.nowMs()-at >= ttl.Milliseconds() {
		return nil, false
	}
	if !ok {
		return nil, true
	}
	p.ImageUrl = imageURL(key, imageType)
	return p, true
}

func (s *Server) GetLinkPreviews(ctx context.Context, req *connect.Request[v1.GetLinkPreviewsRequest]) (*connect.Response[v1.GetLinkPreviewsResponse], error) {
	msg, _, err := loadMessage(ctx, s.db.r, req.Msg.MessageId, me(ctx).Id)
	if err != nil {
		return nil, err
	}
	out := &v1.GetLinkPreviewsResponse{}
	if msg.Deleted {
		return connect.NewResponse(out), nil
	}
	links := linksIn(msg.Text)
	got := make([]*v1.LinkPreview, len(links))
	var wg sync.WaitGroup
	for i, l := range links {
		wg.Go(func() { got[i] = s.linkPreview(l) })
	}
	wg.Wait()
	for i, p := range got {
		if p != nil {
			p.Url = links[i]
			out.Previews = append(out.Previews, p)
		}
	}
	return connect.NewResponse(out), nil
}

// serveUnfurlImage serves a cached preview image. The image came from a
// public page, so it needs no signature; it never runs as a page here.
func (s *Server) serveUnfurlImage(w http.ResponseWriter, r *http.Request) {
	var ctype string
	var img []byte
	err := s.db.r.QueryRowContext(r.Context(), "SELECT image_type, image FROM link_previews WHERE id = ? AND image_type != ''", r.PathValue("id")).Scan(&ctype, &img)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, "could not read the image")
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "public, max-age=86400")
	w.Write(img)
}
