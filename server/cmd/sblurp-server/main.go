// Command sblurp-server runs one Sblurp community.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"sblurp.chat/server/internal/server"
)

type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// Set at build time with -ldflags "-X main.version=... -X main.track=... -X main.updateURL=...".
var (
	version   = "dev"
	track     = "stable"
	updateURL = ""
)

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func main() {
	var cfg server.Config
	var issuers listFlag
	addr := flag.String("addr", env("SBLURP_ADDR", ":8082"), "listen address (SBLURP_ADDR)")
	flag.StringVar(&cfg.DataDir, "data", env("SBLURP_DATA", "data"), "data directory (SBLURP_DATA)")
	flag.StringVar(&cfg.Name, "name", env("SBLURP_NAME", "Sblurp Community"), "community name (SBLURP_NAME)")
	flag.StringVar(&cfg.Description, "description", env("SBLURP_DESCRIPTION", ""), "one-line description (SBLURP_DESCRIPTION)")
	flag.StringVar(&cfg.IconURL, "icon-url", env("SBLURP_ICON_URL", ""), "icon URL (SBLURP_ICON_URL)")
	flag.StringVar(&cfg.Accent, "accent", env("SBLURP_ACCENT", ""), "accent color #rrggbb (SBLURP_ACCENT)")
	flag.StringVar(&cfg.BaseURL, "base-url", env("SBLURP_BASE_URL", ""), "public base URL, also the JWT audience (SBLURP_BASE_URL)")
	flag.StringVar(&cfg.WebURL, "web-url", env("SBLURP_WEB_URL", "https://app.sblurp.chat"), "web client that invite links open (SBLURP_WEB_URL)")
	flag.Var(&issuers, "trusted-issuer", "trusted login issuer; repeat for more (SBLURP_TRUSTED_ISSUERS, comma separated)")
	flag.StringVar(&cfg.Seed, "seed", env("SBLURP_SEED", ""), "seed an empty database with demo data: community or owls (SBLURP_SEED)")
	botRate, _ := strconv.ParseFloat(env("SBLURP_BOT_RATE", "0"), 64)
	botBurst, _ := strconv.Atoi(env("SBLURP_BOT_BURST", "20"))
	flag.Float64Var(&cfg.BotRate, "bot-rate", botRate, "bot messages per second, 0 = unlimited (SBLURP_BOT_RATE)")
	flag.IntVar(&cfg.BotBurst, "bot-burst", botBurst, "bot message burst (SBLURP_BOT_BURST)")
	flag.Parse()
	cfg.Version = version
	cfg.Track = env("SBLURP_TRACK", track)
	cfg.UpdateURL = env("SBLURP_UPDATE_URL", updateURL)
	if env("SBLURP_UPDATE_CHECK", "on") == "off" {
		cfg.UpdateURL = ""
	}

	cfg.TrustedIssuers = issuers
	if len(issuers) == 0 && os.Getenv("SBLURP_TRUSTED_ISSUERS") != "" {
		cfg.TrustedIssuers = strings.Split(os.Getenv("SBLURP_TRUSTED_ISSUERS"), ",")
	}
	if len(cfg.TrustedIssuers) == 0 {
		cfg.TrustedIssuers = []string{"https://sblurp.chat"}
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg.Logger = log
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Error("data dir", "err", err)
		os.Exit(1)
	}
	s, err := server.New(cfg)
	if err != nil {
		log.Error("start", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		Protocols:         new(http.Protocols),
	}
	srv.Protocols.SetHTTP1(true)
	srv.Protocols.SetUnencryptedHTTP2(true) // h2c for gRPC clients and proxies

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Info("shutting down")
		s.DropSubscribers()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	log.Info("listening", "version", cfg.Version, "track", cfg.Track, "addr", *addr, "name", cfg.Name, "base_url", cfg.BaseURL, "trusted_issuers", cfg.TrustedIssuers)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
	s.Close()
}
