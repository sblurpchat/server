package server

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestLinksIn(t *testing.T) {
	got := linksIn("see https://a.com/x, and (https://B.com/y) `https://code.com` ```\nhttps://block.com\n``` https://a.com/x#frag [t](https://c.com/z) http://d.com https://e.com https://f.com https://g.com ftp://h.com")
	want := []string{"https://a.com/x", "https://B.com/y", "https://c.com/z", "http://d.com", "https://e.com"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{
		"HTTPS://Example.COM":             "https://example.com/",
		"https://example.com:443/a?b=1#c": "https://example.com/a?b=1",
		"http://example.com:80/":          "http://example.com/",
		"http://example.com:8080/":        "http://example.com:8080/",
		"https://[2001:DB8::1]/x":         "https://[2001:db8::1]/x",
	} {
		if got, err := normalizeURL(in); err != nil || got != want {
			t.Errorf("normalizeURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"ftp://example.com/", "javascript:alert(1)", "https://user:pw@example.com/", "https:///nohost", "file:///etc/passwd"} {
		if got, err := normalizeURL(in); err == nil {
			t.Errorf("normalizeURL(%q) = %q, want an error", in, got)
		}
	}
}

func TestPublicAddr(t *testing.T) {
	for _, s := range []string{
		"127.0.0.1:80", "10.1.2.3:443", "172.16.0.1:80", "192.168.1.1:80", "169.254.169.254:80", "100.64.0.1:80",
		"224.0.0.1:80", "0.0.0.0:80", "255.255.255.255:80", "[::1]:80", "[::]:443", "[fc00::1]:443", "[fd12::1]:443",
		"[fe80::1]:80", "[ff02::1]:80", "[::ffff:127.0.0.1]:80", "[::ffff:8.8.8.8]:80", "[64:ff9b::a00:1]:80",
		"8.8.8.8:8080", "8.8.8.8:22", "[2606:4700::1111]:25",
	} {
		if publicAddr(netip.MustParseAddrPort(s)) {
			t.Errorf("%s allowed, want refused", s)
		}
	}
	for _, s := range []string{"8.8.8.8:80", "1.1.1.1:443", "[2606:4700::1111]:443"} {
		if !publicAddr(netip.MustParseAddrPort(s)) {
			t.Errorf("%s refused, want allowed", s)
		}
	}
}

func TestParseHead(t *testing.T) {
	doc := `<!doctype html><html><head><!-- <meta property="og:title" content="comment"> -->
<title>Fallback &amp; title</title>
<script>var s = "<meta property='og:title' content='script'>";</script>
<META PROPERTY="og:title" CONTENT="Macotron &mdash;  a   Mac">
<meta name=description content=plain>
<meta property="og:description" content='Tiny &quot;app&quot;'>
<meta name="twitter:image" content="/img.png">
<meta property="og:site_name" content="statico">
</head><body><meta property="og:image" content="/late.png"></body></html>`
	got := parseHead(doc)
	want := pageMeta{title: "Macotron — a Mac", description: `Tiny "app"`, siteName: "statico", image: "/img.png"}
	if got != want {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if got := parseHead("<html><head><title>Only\n  title</title><meta name='description' content='d'>"); got.title != "Only title" || got.description != "d" {
		t.Fatalf("fallbacks: %+v", got)
	}
	if got := parseHead(`<head><meta property="og:title" content="unterminated`); got.title != "" {
		t.Fatalf("unterminated attribute: %+v", got)
	}
}

func allowAll(netip.AddrPort) bool { return true }

// A page on 127.0.0.1 is refused by the real guard, and the site is never contacted.
func TestUnfurlRefusesLoopback(t *testing.T) {
	var hits atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer site.Close()
	u := &unfurler{}
	if p := u.fetchPreview(site.URL + "/"); p.ok {
		t.Fatal("loopback page fetched")
	}
	if hits.Load() != 0 {
		t.Fatal("site was contacted")
	}
}

// Every redirect is checked: an allowed site cannot bounce us to a refused one.
func TestUnfurlRechecksRedirects(t *testing.T) {
	var inner atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner.Add(1)
		fmt.Fprint(w, `<title>secret</title>`)
	}))
	defer target.Close()
	front := httptest.NewServer(http.RedirectHandler(target.URL+"/", http.StatusFound))
	defer front.Close()
	frontAddr := netip.MustParseAddrPort(strings.TrimPrefix(front.URL, "http://"))
	u := &unfurler{allow: func(ap netip.AddrPort) bool { return ap == frontAddr }}
	if p := u.fetchPreview(front.URL + "/"); p.ok || inner.Load() != 0 {
		t.Fatalf("redirect to a refused address was followed: %+v", p)
	}
}

func TestUnfurlLimits(t *testing.T) {
	var hops atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/loop", func(w http.ResponseWriter, r *http.Request) {
		hops.Add(1)
		http.Redirect(w, r, "/loop", http.StatusFound)
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<head><!--"+strings.Repeat("x", unfurlMaxHTML)+"--><title>too late</title>")
	})
	mux.HandleFunc("/text", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "<title>plain</title>")
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(10 * time.Second):
		case <-r.Context().Done():
		}
	})
	site := httptest.NewServer(mux)
	defer site.Close()
	u := &unfurler{allow: allowAll}
	if p := u.fetchPreview(site.URL + "/loop"); p.ok || hops.Load() != 4 {
		t.Fatalf("redirect loop: ok=%v hops=%d, want 4 (1 + 3 redirects)", p.ok, hops.Load())
	}
	for _, path := range []string{"/big", "/text"} {
		if p := u.fetchPreview(site.URL + path); p.ok {
			t.Fatalf("%s: %+v", path, p)
		}
	}
	start := time.Now()
	if p := u.fetchPreview(site.URL + "/slow"); p.ok || time.Since(start) > unfurlTimeout+2*time.Second {
		t.Fatalf("slow: ok=%v after %v", p.ok, time.Since(start))
	}
}

func TestGetLinkPreviews(t *testing.T) {
	e := newEnv(t)
	e.s.unfurl.allow = allowAll
	var pages, images atomic.Int32
	var ua string
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		pages.Add(1)
		mu.Lock()
		ua = r.UserAgent()
		mu.Unlock()
		time.Sleep(50 * time.Millisecond) // let concurrent callers pile up
		fmt.Fprint(w, `<html><head><meta property="og:title" content="Macotron"><meta property="og:description" content="A tiny Mac"><meta property="og:image" content="/i.png"></head>`)
	})
	mux.HandleFunc("/i.png", func(w http.ResponseWriter, r *http.Request) {
		images.Add(1)
		w.Write(pngBytes(2, 2))
	})
	mux.HandleFunc("/svg", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<title>Svg</title><meta property="og:image" content="/x.svg">`)
	})
	mux.HandleFunc("/x.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		fmt.Fprint(w, `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	})
	site := httptest.NewServer(mux)
	defer site.Close()

	alice := e.join("alice")
	ch := alice.channel("links", v1.ChannelKind_CHANNEL_KIND_TEXT)
	msg := alice.send(ch.Id, "look "+site.URL+"/page and "+site.URL+"/svg and "+site.URL+"/missing")

	var wg sync.WaitGroup
	results := make([]*v1.GetLinkPreviewsResponse, 8)
	for i := range results {
		wg.Go(func() {
			results[i] = must(alice.chat.GetLinkPreviews(ctx(), connect.NewRequest(&v1.GetLinkPreviewsRequest{MessageId: msg.Id})))
		})
	}
	wg.Wait()
	if pages.Load() != 1 || images.Load() != 1 {
		t.Fatalf("pages=%d images=%d, want one fetch each", pages.Load(), images.Load())
	}
	if !strings.Contains(ua, "Sblurpbot/1.0") {
		t.Fatalf("user agent %q", ua)
	}
	got := results[0].Previews
	if len(got) != 2 {
		t.Fatalf("got %d previews, want 2 (missing page left out): %v", len(got), got)
	}
	p := got[0]
	if p.Url != site.URL+"/page" || p.Title != "Macotron" || p.Description != "A tiny Mac" || p.SiteName != "127.0.0.1" || !strings.HasPrefix(p.ImageUrl, "/unfurl/") {
		t.Fatalf("preview %+v", p)
	}
	if got[1].Title != "Svg" || got[1].ImageUrl != "" {
		t.Fatalf("svg image should be dropped: %+v", got[1])
	}
	res, err := http.Get(e.url + p.ImageUrl)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.Header.Get("Content-Type") != "image/png" || !bytes.Equal(body, pngBytes(2, 2)) || res.Header.Get("X-Content-Type-Options") != "nosniff" ||
		res.Header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Fatalf("image: %s %q", res.Header.Get("Content-Type"), body)
	}

	// Cached for a day; then fetched again.
	e.clock.Advance(23 * time.Hour)
	alice = e.client(e.token("alice"))
	must(alice.chat.GetLinkPreviews(ctx(), connect.NewRequest(&v1.GetLinkPreviewsRequest{MessageId: msg.Id})))
	if pages.Load() != 1 {
		t.Fatalf("refetched within a day: %d", pages.Load())
	}
	e.clock.Advance(2 * time.Hour)
	alice = e.client(e.token("alice"))
	must(alice.chat.GetLinkPreviews(ctx(), connect.NewRequest(&v1.GetLinkPreviewsRequest{MessageId: msg.Id})))
	if pages.Load() != 2 {
		t.Fatalf("not refetched after a day: %d", pages.Load())
	}

	// Only members who can see the message get its previews.
	bob := e.join("bob")
	priv := alice.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	hidden := alice.send(priv.Id, site.URL+"/page")
	_, err = bob.chat.GetLinkPreviews(ctx(), connect.NewRequest(&v1.GetLinkPreviewsRequest{MessageId: hidden.Id}))
	wantCode(t, err, connect.CodeNotFound)
}
