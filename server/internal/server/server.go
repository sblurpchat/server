// Package server is the Sblurp community server: storage, auth, the Connect
// services, live events, uploads and demo seed data.
package server

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"

	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
	"sblurp.chat/server/internal/mcp"
)

// Config holds everything the server needs. Zero values get defaults.
type Config struct {
	Name           string
	Description    string
	IconURL        string
	Accent         string
	BaseURL        string // canonical URL, also the JWT audience
	WebURL         string // web client that opens invite links; default https://app.sblurp.chat
	TrustedIssuers []string
	DataDir        string
	Seed           string  // "community", "owls" or ""; only used on an empty database
	BotRate        float64 // SendMessage per second for bots; 0 = no limit
	BotBurst       int
	PluginMemory   int           // bytes per plugin; default 32 MB
	PluginTimeout  time.Duration // per hook call; default 1s
	Version        string        // build version, e.g. "1.2.3" or "nightly-20261016-abc1234"
	Track          string        // stable, beta, nightly or head (built from source)
	UpdateURL      string        // release manifest; "" turns the daily update check off

	// For tests.
	Now        func() time.Time
	Heartbeat  time.Duration // default 25s
	KeepEvents int           // default 10,000
	KeepFor    time.Duration // default 7 days
	HTTPClient *http.Client  // fetches JWKS
	Logger     *slog.Logger
}

type Server struct {
	cfg             Config
	db              *db
	hub             *hub
	jwks            *jwks
	limiter         *limiter
	log             *slog.Logger
	now             func() time.Time
	filesDir        string
	fileKey         []byte
	pluginsMu       sync.Mutex // guards plugins and pluginErrs
	plugins         []*plugin
	pluginErrs      map[string]string // plugin name -> why it did not load
	pluginOps       sync.Mutex        // one admin plugin change at a time
	pluginJobs      chan func()
	writeWait       time.Duration
	updateAvailable atomic.Pointer[string]
	emoji           emojiCache
	unfurl          unfurler
	wg              sync.WaitGroup
	stop            chan struct{}
}

// New opens (or creates) the database under cfg.DataDir and seeds it if asked.
func New(cfg Config) (*Server, error) {
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.BaseURL == "" {
		return nil, errors.New("base URL is required")
	}
	cfg.WebURL = cmp.Or(strings.TrimRight(cfg.WebURL, "/"), "https://app.sblurp.chat")
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Heartbeat == 0 {
		cfg.Heartbeat = 25 * time.Second
	}
	if cfg.KeepEvents == 0 {
		cfg.KeepEvents = 10000
	}
	if cfg.KeepFor == 0 {
		cfg.KeepFor = 7 * 24 * time.Hour
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if cfg.PluginMemory == 0 {
		cfg.PluginMemory = defaultPluginMemory
	}
	if cfg.PluginTimeout == 0 {
		cfg.PluginTimeout = defaultPluginTimeout
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	filesDir := filepath.Join(cfg.DataDir, "files")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		return nil, err
	}
	fileKey, err := loadFileKey(filepath.Join(cfg.DataDir, "file-key"))
	if err != nil {
		return nil, err
	}
	d, err := openDB(filepath.Join(cfg.DataDir, "sblurp.db"))
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg: cfg, db: d, log: cfg.Logger, now: cfg.Now,
		jwks:      &jwks{client: cfg.HTTPClient, now: cfg.Now, byIss: map[string]*issuerKeys{}},
		limiter:   &limiter{now: cfg.Now, buckets: map[string]*bucket{}},
		filesDir:  filesDir,
		fileKey:   fileKey,
		writeWait: writeWait,
		stop:      make(chan struct{}),
	}
	s.hub = newHub(s.nowMs)
	if cfg.Seed != "" {
		if err := s.seed(context.Background(), cfg.Seed); err != nil {
			d.close()
			return nil, fmt.Errorf("seed: %w", err)
		}
	}
	if err := s.prune(context.Background()); err != nil {
		d.close()
		return nil, err
	}
	s.wg.Add(1)
	go s.pruneLoop()
	if cfg.UpdateURL != "" {
		s.wg.Add(1)
		go s.updateLoop()
	}
	s.loadPlugins()
	return s, nil
}

func (s *Server) nowMs() int64 { return s.now().UnixMilli() }

func (s *Server) pruneLoop() {
	defer s.wg.Done()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := s.pruneMessages(context.Background()); err != nil {
			s.log.Error("prune messages", "err", err)
		}
		select {
		case <-s.stop:
			return
		case <-t.C:
			if err := s.prune(context.Background()); err != nil {
				s.log.Error("prune events", "err", err)
			}
			s.limiter.sweep()
		}
	}
}

// Close stops background work and closes the database. Call it after the
// HTTP server has shut down.
func (s *Server) Close() {
	close(s.stop)
	s.wg.Wait()
	s.db.close()
}

// Handler returns the full HTTP handler: Connect services, uploads, files,
// all behind CORS.
func (s *Server) Handler() http.Handler {
	// Most events are a few hundred bytes; gzip per streamed event cost
	// about 10% CPU for little gain. Big replies (GetState) still compress.
	opts := connect.WithHandlerOptions(connect.WithInterceptors(interceptor{s}), connect.WithCompressMinBytes(1024))
	mux := http.NewServeMux()
	path, h := sblurpv1connect.NewServerServiceHandler(s, opts)
	mux.Handle(path, batchFlushes(h))
	mux.Handle(sblurpv1connect.NewChatServiceHandler(s, opts))
	mux.Handle(sblurpv1connect.NewBotServiceHandler(s, opts))
	mux.HandleFunc("POST /upload", s.upload)
	mux.HandleFunc("GET /files/{id}/{name}", s.serveFile)
	mux.HandleFunc("GET /emoji", s.listEmoji)
	mux.HandleFunc("POST /emoji", s.uploadEmoji)
	mux.HandleFunc("GET /emoji.zip", s.exportEmoji)
	mux.HandleFunc("GET /emoji/{id}", s.serveEmoji)
	mux.HandleFunc("GET /unfurl/{id}", s.serveUnfurlImage)
	mux.HandleFunc("GET /invite/{code}", s.inviteRedirect)
	mux.HandleFunc("GET /i/{code}", s.inviteRedirect)
	mux.HandleFunc("GET /{$}", s.splash)
	mux.HandleFunc("GET /sblurp-logo.png", s.splashLogo)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	mcp.New(s.cfg.BaseURL, s.cfg.TrustedIssuers, s.cfg.Version, mux).Mount(mux)
	return cors(mux)
}

// inviteRedirect sends a browser that opened an invite link to the web
// client's join screen, with this server and the code filled in.
func (s *Server) inviteRedirect(w http.ResponseWriter, r *http.Request) {
	q := url.Values{"url": {s.cfg.BaseURL}, "invite": {r.PathValue("code")}}
	http.Redirect(w, r, s.cfg.WebURL+"/#/join?"+q.Encode(), http.StatusFound)
}

// cors allows any origin: any client may talk to any community server.
// Credentials are bearer tokens, never cookies, so "*" is safe.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin, WWW-Authenticate")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Connect-Protocol-Version, Connect-Timeout-Ms, Content-Type, Authorization, Grpc-Timeout, X-Grpc-Web, X-User-Agent, Mcp-Protocol-Version")
			h.Set("Access-Control-Max-Age", "7200")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// heldWriter lets Subscribe write several events with one flush: connect
// flushes after every Send (1059).
type heldWriter struct {
	http.ResponseWriter
	hold bool
}

func (w *heldWriter) Flush() {
	if !w.hold {
		http.NewResponseController(w.ResponseWriter).Flush()
	}
}

func (w *heldWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type heldWriterKey struct{}

func batchFlushes(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != sblurpv1connect.ServerServiceSubscribeProcedure {
			next.ServeHTTP(w, r)
			return
		}
		hw := &heldWriter{ResponseWriter: w}
		next.ServeHTTP(hw, r.WithContext(context.WithValue(r.Context(), heldWriterKey{}, hw)))
	})
}

// limiter is a token bucket per member for SendMessage.
type limiter struct {
	now     func() time.Time
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
	full   time.Time // when the bucket refills to burst; then it can go
}

func (l *limiter) allow(member string, rate float64, burst int) bool {
	if rate <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.buckets[member]
	if b == nil {
		b = &bucket{tokens: float64(burst), last: now}
		l.buckets[member] = b
	}
	b.tokens = min(float64(burst), b.tokens+now.Sub(b.last).Seconds()*rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	b.full = now.Add(time.Duration((float64(burst) - b.tokens) / rate * float64(time.Second)))
	return true
}

// sweep drops buckets that have refilled. A fresh bucket starts full, so
// this changes nothing for the member.
func (l *limiter) sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, b := range l.buckets {
		if !now.Before(b.full) {
			delete(l.buckets, k)
		}
	}
}

// DropSubscribers ends every Subscribe stream so an HTTP shutdown does not
// wait on them. Clients reconnect and resume by seq.
func (s *Server) DropSubscribers() { s.hub.closeAll() }
