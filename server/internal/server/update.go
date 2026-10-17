package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// release is one track's entry in the release manifest (releases.json),
// which the release workflow publishes to GitHub Pages.
type release struct {
	Version  string `json:"version"`
	Digest   string `json:"digest"`
	Date     string `json:"date"`
	NotesURL string `json:"notes_url"`
}

// updateLoop fetches the manifest once at start and then daily, and keeps
// the newer version on our track for GetMe. It sends nothing but a plain GET.
func (s *Server) updateLoop() {
	defer s.wg.Done()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		if v, err := s.checkUpdate(); err != nil {
			s.log.Warn("update check", "err", err)
		} else {
			s.updateAvailable.Store(&v)
			if v != "" {
				s.log.Info("update available", "version", v, "track", s.cfg.Track)
			}
		}
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
	}
}

func (s *Server) checkUpdate() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.UpdateURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", s.cfg.UpdateURL, resp.Status)
	}
	var m map[string]release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&m); err != nil {
		return "", err
	}
	if latest := m[s.cfg.Track].Version; newerVersion(s.cfg.Version, latest) {
		return latest, nil
	}
	return "", nil
}

// newerVersion reports whether latest is newer than cur. Versions are
// "1.2.3", "1.2.3-beta.4" (a beta sorts before its release) or
// "nightly-YYYYMMDD-<sha>" (compared by date). Anything else, such as
// "dev", or a nightly against a numbered version, is never newer.
func newerVersion(cur, latest string) bool {
	if cd, ok := nightlyDate(cur); ok {
		ld, ok := nightlyDate(latest)
		return ok && ld > cd
	}
	c, ok1 := parseSemver(cur)
	l, ok2 := parseSemver(latest)
	if !ok1 || !ok2 {
		return false
	}
	for i := range c {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func nightlyDate(v string) (string, bool) {
	parts := strings.Split(v, "-")
	if len(parts) != 3 || parts[0] != "nightly" || len(parts[1]) != 8 {
		return "", false
	}
	if _, err := strconv.Atoi(parts[1]); err != nil {
		return "", false
	}
	return parts[1], true
}

// parseSemver returns major, minor, patch and beta number; a release has
// beta = MaxInt so it sorts after its betas.
func parseSemver(v string) ([4]int, bool) {
	var out [4]int
	v = strings.TrimPrefix(v, "v")
	core, beta, isBeta := strings.Cut(v, "-beta.")
	nums := strings.Split(core, ".")
	if len(nums) != 3 {
		return out, false
	}
	for i, n := range nums {
		x, err := strconv.Atoi(n)
		if err != nil || x < 0 {
			return out, false
		}
		out[i] = x
	}
	out[3] = int(^uint(0) >> 1)
	if isBeta {
		x, err := strconv.Atoi(beta)
		if err != nil || x < 0 {
			return out, false
		}
		out[3] = x
	}
	return out, true
}
