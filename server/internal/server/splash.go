package server

import (
	_ "embed"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"

	"rsc.io/qr"
)

//go:embed splash-logo.png
var splashLogo []byte

// splash is the page a browser sees at the server's root: what this is,
// and the quickest way in: a QR code and a button that both open the web
// client's join screen for this server. Invite-only servers say so once.
func (s *Server) splash(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var members int
	if err := s.db.r.QueryRowContext(ctx, "SELECT COUNT(*) FROM members WHERE deleted = 0").Scan(&members); err != nil {
		httpError(w, http.StatusInternalServerError, "cannot load server info")
		return
	}
	inviteOnly, err := needsCode(ctx, s.db.r)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot load server info")
		return
	}
	desc, _, err := s.profile(ctx, s.db.r)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot load server info")
		return
	}
	icon, _ := s.iconURL(ctx, s.db.r)
	join := s.cfg.WebURL + "/#/join?" + url.Values{"url": {s.cfg.BaseURL}}.Encode()
	host := s.cfg.BaseURL
	if u, err := url.Parse(s.cfg.BaseURL); err == nil && u.Host != "" {
		host = u.Host
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-cache")
	splashPage.Execute(w, map[string]any{
		"Name": s.cfg.Name, "Description": desc, "Icon": icon, "Members": members,
		"InviteOnly": inviteOnly, "Host": host, "Join": join, "QR": qrSVG(join),
	})
}

func (s *Server) splashLogo(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(splashLogo)
}

// qrSVG draws text as a QR code, one path for all dark modules, with the
// standard four-module quiet zone.
func qrSVG(text string) template.HTML {
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		return ""
	}
	n := c.Size + 8
	var b strings.Builder
	fmt.Fprintf(&b, `<svg class="qr" viewBox="0 0 %d %d" role="img" aria-label="QR code that opens the join screen"><rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n, n, n, n)
	for y := 0; y < c.Size; y++ {
		for x := 0; x < c.Size; x++ {
			if c.Black(x, y) {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x+4, y+4)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return template.HTML(b.String())
}

var splashPage = template.Must(template.New("splash").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Name}} on Sblurp</title>
<meta name="description" content="{{.Name}} is a Sblurp chat community. Add {{.Host}} in Sblurp to join.">
<style>
:root { color-scheme: light dark; --bg: #F2FAF2; --ink: #0B2412; --muted: #4F6B57; --line: #CFE6D2; --green: #31C843; --btn-ink: #04210B; }
@media (prefers-color-scheme: dark) { :root { --bg: #061209; --ink: #E3F6E5; --muted: #8BAA93; --line: #1B3623; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 32px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 360px; text-align: center; }
.icon { display: block; width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 14px; object-fit: cover; }
h1 { margin: 0; font-size: 28px; line-height: 1.15; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.meta { margin: 6px 0 0; color: var(--muted); font-size: 15px; }
.desc { margin: 12px 0 0; }
.qr { display: block; width: 100%; max-width: 232px; height: auto; margin: 28px auto 0; border-radius: 16px; }
.btn { display: block; margin: 28px auto 0; max-width: 232px; padding: 13px 20px; border-radius: 12px; background: var(--green); color: var(--btn-ink); font-weight: 700; text-decoration: none; transition: filter 150ms ease-out; }
.btn:hover { filter: brightness(1.06); }
.alt { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
code { font: 600 14px/1.4 ui-monospace, "SF Mono", Menlo, monospace; color: var(--ink); overflow-wrap: anywhere; }
a:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; border-radius: 6px; }
.brand { display: inline-flex; align-items: center; gap: 6px; margin-top: 48px; color: var(--muted); font-size: 13px; text-decoration: none; }
.brand img { width: 18px; height: 18px; }
.brand:hover { color: var(--ink); }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
</head>
<body>
<main>
  {{if .Icon}}<img class="icon" src="{{.Icon}}" width="56" height="56" alt="">{{end}}
  <h1>{{.Name}}</h1>
  <p class="meta">{{.Members}} member{{if ne .Members 1}}s{{end}}{{if .InviteOnly}}, invite only{{end}}</p>
  {{if .Description}}<p class="desc">{{.Description}}</p>{{end}}
  {{.QR}}
  <a class="btn" href="{{.Join}}">Join in your browser</a>
  <p class="alt">Or add <code>{{.Host}}</code> in the Sblurp app.</p>
  <a class="brand" href="https://sblurp.chat"><img src="/sblurp-logo.png" width="18" height="18" alt="">Runs on Sblurp</a>
</main>
</body>
</html>
`))
