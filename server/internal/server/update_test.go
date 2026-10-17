package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		cur, latest string
		want        bool
	}{
		{"1.2.3", "1.2.4", true},
		{"1.2.3", "1.3.0", true},
		{"1.2.3", "2.0.0", true},
		{"1.9.0", "1.10.0", true}, // numeric, not string, compare
		{"1.2.3", "1.2.3", false},
		{"1.2.4", "1.2.3", false},
		{"v1.2.3", "1.2.4", true},
		{"1.3.0-beta.1", "1.3.0-beta.2", true},
		{"1.3.0-beta.2", "1.3.0-beta.10", true},
		{"1.3.0-beta.2", "1.3.0", true}, // release beats its betas
		{"1.3.0", "1.3.0-beta.9", false},
		{"1.2.3", "1.3.0-beta.1", true},
		{"1.3.0-beta.1", "1.2.9", false},
		{"nightly-20261015-abc1234", "nightly-20261016-def5678", true},
		{"nightly-20261016-abc1234", "nightly-20261016-def5678", false},
		{"nightly-20261016-abc1234", "nightly-20261015-def5678", false},
		{"nightly-20261016-abc1234", "1.2.3", false},
		{"1.2.3", "nightly-20261016-abc1234", false},
		{"dev", "1.2.3", false},
		{"1.2.3", "", false},
		{"1.2", "1.3", false},
		{"1.2.3-rc.1", "1.2.4", false},
	} {
		if got := newerVersion(c.cur, c.latest); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.cur, c.latest, got, c.want)
		}
	}
}

func TestCheckUpdate(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"stable":{"version":"1.2.4"},"beta":{"version":"1.3.0-beta.1"},"nightly":{"version":"nightly-20261016-abc1234"}}`))
	}))
	defer ts.Close()
	for track, want := range map[string]string{"stable": "1.2.4", "beta": "1.3.0-beta.1", "nightly": ""} {
		s := &Server{cfg: Config{Version: "1.2.3", Track: track, UpdateURL: ts.URL, HTTPClient: ts.Client()}}
		got, err := s.checkUpdate()
		if err != nil || got != want {
			t.Errorf("track %s: got %q, %v; want %q", track, got, err, want)
		}
	}
}

func TestGetMeUpdateAvailable(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"stable":{"version":"1.2.4"}}`))
	}))
	defer ts.Close()
	e := newEnv(t, func(c *Config) { c.Version, c.Track, c.UpdateURL = "1.2.3", "stable", ts.URL })
	for i := 0; e.s.updateAvailable.Load() == nil; i++ {
		if i > 200 {
			t.Fatal("update check never ran")
		}
		time.Sleep(10 * time.Millisecond)
	}
	owner := e.join("ana")
	got := must(owner.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{})))
	if got.ServerVersion != "1.2.3" || got.ServerTrack != "stable" || got.UpdateAvailable != "1.2.4" {
		t.Fatalf("owner GetMe = %v", got)
	}
	member := e.join("bo")
	got = must(member.srv.GetMe(ctx(), connect.NewRequest(&v1.GetMeRequest{})))
	if got.ServerVersion != "" || got.ServerTrack != "" || got.UpdateAvailable != "" {
		t.Fatalf("member GetMe = %v", got)
	}
}
