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
// and the quickest way in. Invite-only servers say so; the QR code opens
// the web client's join screen for this server.
func (s *Server) splash(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var members int
	if err := s.db.r.QueryRowContext(ctx, "SELECT COUNT(*) FROM members WHERE deleted = 0").Scan(&members); err != nil {
		httpError(w, http.StatusInternalServerError, "cannot load server info")
		return
	}
	inviteOnly, err := isInviteOnly(ctx, s.db.r)
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
:root { color-scheme: light dark; --bg: #F2FAF2; --surface: #fff; --ink: #0B2412; --muted: #4F6B57; --line: #CFE6D2; --green: #31C843; --btn-ink: #04210B; }
@media (prefers-color-scheme: dark) { :root { --bg: #061209; --surface: #0C1F12; --ink: #E3F6E5; --muted: #8BAA93; --line: #1B3623; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 420px; text-align: center; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 600; }
.brand img { width: 24px; height: 24px; }
.brand:hover { color: var(--ink); }
.card { margin-top: 20px; padding: 28px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 20px; }
.icon { width: 64px; height: 64px; border-radius: 16px; object-fit: cover; }
h1 { margin: 12px 0 4px; font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.meta { margin: 0; color: var(--muted); font-size: 14px; }
.desc { margin: 12px 0 0; }
.qr { display: block; width: 200px; height: 200px; margin: 24px auto 0; border-radius: 12px; }
.how { margin: 20px 0 0; }
code { font: 600 15px/1.4 ui-monospace, "SF Mono", Menlo, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; overflow-wrap: anywhere; }
.btn { display: inline-block; margin-top: 20px; padding: 12px 22px; border-radius: 12px; background: var(--green); color: var(--btn-ink); font-weight: 700; text-decoration: none; transition: filter 150ms ease-out; }
.btn:hover { filter: brightness(1.06); }
.note { margin: 16px 0 0; color: var(--muted); font-size: 14px; }
a:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; border-radius: 6px; }
footer { margin-top: 20px; color: var(--muted); font-size: 14px; }
footer a { color: inherit; }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
</head>
<body>
<main>
  <a class="brand" href="https://sblurp.chat"><img src="/sblurp-logo.png" width="24" height="24" alt="">Sblurp chat server</a>
  <div class="card">
    {{if .Icon}}<img class="icon" src="{{.Icon}}" width="64" height="64" alt="">{{end}}
    <h1>{{.Name}}</h1>
    <p class="meta">{{.Members}} member{{if ne .Members 1}}s{{end}}{{if .InviteOnly}}, invite only{{end}}</p>
    {{if .Description}}<p class="desc">{{.Description}}</p>{{end}}
    {{.QR}}
    <p class="how">Scan the code, or add <code>{{.Host}}</code> in Sblurp to join.</p>
    <a class="btn" href="{{.Join}}">Join in your browser</a>
    {{if .InviteOnly}}<p class="note">This community is invite only. You need an invite link or code from a member.</p>{{end}}
  </div>
  <footer>Sblurp is chat where each community runs its own server. <a href="https://sblurp.chat">Learn more at sblurp.chat</a></footer>
</main>
</body>
</html>
`))
