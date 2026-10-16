// Package server is the Sblurp community server: storage, auth, the Connect
// services, live events, uploads and demo seed data.
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

// Config holds everything the server needs. Zero values get defaults.
type Config struct {
	Name           string
	Description    string
	IconURL        string
	Accent         string
	BaseURL        string // canonical URL, also the JWT audience
	TrustedIssuers []string
	DataDir        string
	Seed           string  // "community", "owls" or ""; only used on an empty database
	BotRate        float64 // SendMessage per second for bots; 0 = no limit
	BotBurst       int

	// For tests.
	Now        func() time.Time
	Heartbeat  time.Duration // default 25s
	KeepEvents int           // default 10,000
	KeepFor    time.Duration // default 7 days
	HTTPClient *http.Client  // fetches JWKS
	Logger     *slog.Logger
}

type Server struct {
	cfg        Config
	db         *db
	hub        *hub
	jwks       *jwks
	limiter    *limiter
	log        *slog.Logger
	now        func() time.Time
	heartbeat  time.Duration
	keepEvents int
	keepFor    time.Duration
	filesDir   string
	fileKey    []byte
	wg         sync.WaitGroup
	stop       chan struct{}
}

// New opens (or creates) the database under cfg.DataDir and seeds it if asked.
func New(cfg Config) (*Server, error) {
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.BaseURL == "" {
		return nil, errors.New("base URL is required")
	}
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
		jwks:       &jwks{client: cfg.HTTPClient, now: cfg.Now, byIss: map[string]*issuerKeys{}},
		limiter:    &limiter{now: cfg.Now, buckets: map[string]*bucket{}},
		heartbeat:  cfg.Heartbeat,
		keepEvents: cfg.KeepEvents,
		keepFor:    cfg.KeepFor,
		filesDir:   filesDir,
		fileKey:    fileKey,
		stop:       make(chan struct{}),
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
	return s, nil
}

func (s *Server) nowMs() int64 { return s.now().UnixMilli() }

func (s *Server) pruneLoop() {
	defer s.wg.Done()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			if err := s.prune(context.Background()); err != nil {
				s.log.Error("prune events", "err", err)
			}
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
	opts := connect.WithInterceptors(interceptor{s})
	mux := http.NewServeMux()
	mux.Handle(sblurpv1connect.NewServerServiceHandler(s, opts))
	mux.Handle(sblurpv1connect.NewChatServiceHandler(s, opts))
	mux.Handle(sblurpv1connect.NewBotServiceHandler(s, opts))
	mux.HandleFunc("POST /upload", s.upload)
	mux.HandleFunc("GET /files/{id}/{name}", s.serveFile)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	return cors(mux)
}

// cors allows any origin: any client may talk to any community server.
// Credentials are bearer tokens, never cookies, so "*" is safe.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Connect-Protocol-Version, Connect-Timeout-Ms, Content-Type, Authorization, Grpc-Timeout, X-Grpc-Web, X-User-Agent")
			h.Set("Access-Control-Max-Age", "7200")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
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
}

// ponytail: buckets are never evicted; one small struct per member that ever
// sent a message. Sweep idle ones if member counts get large.
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
	return true
}

// DropSubscribers ends every Subscribe stream so an HTTP shutdown does not
// wait on them. Clients reconnect and resume by seq.
func (s *Server) DropSubscribers() { s.hub.closeAll() }
