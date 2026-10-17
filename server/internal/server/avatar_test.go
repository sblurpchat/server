package server

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// A member sets a picture for this community from their own upload. Others
// get a signed absolute URL, the upload survives the orphan prune, and going
// back to an outside URL frees it (1042).
func TestUploadedAvatar(t *testing.T) {
	e := newEnv(t)
	ana, bob := e.join("ana"), e.join("bob")
	_, pic := ana.upload("me.png", pngBytes(2, 2))
	_, txt := ana.upload("notes.txt", []byte("hi"))
	_, bobs := bob.upload("bob.png", pngBytes(1, 1))
	set := func(c *client, v string) (*v1.Member, error) {
		res, err := c.srv.UpdateProfile(ctx(), connect.NewRequest(&v1.UpdateProfileRequest{AvatarUrl: &v}))
		if err != nil {
			return nil, err
		}
		return res.Msg.Member, nil
	}
	for _, v := range []string{bobs.Url, txt.Url, "/files/", "/files/nope/x.png"} {
		_, err := set(ana, v)
		wantCode(t, err, connect.CodeInvalidArgument)
	}

	sub := bob.subscribe(bob.state().Seq)
	signed := func(m *v1.Member) {
		t.Helper()
		if !strings.HasPrefix(m.GetAvatarUrl(), e.url+"/files/"+pic.Id+"/me.png?exp=") || !strings.Contains(m.AvatarUrl, "&sig=") {
			t.Fatalf("avatar_url = %q", m.GetAvatarUrl())
		}
	}
	signed(must2(set(ana, pic.Url))) // the relative URL the upload returned
	signed(sub.next(func(ev *v1.Event) bool { return ev.GetMemberUpdated() != nil }, nil).GetMemberUpdated())
	for _, m := range bob.state().Members {
		if m.Username == "ana" {
			signed(m)
			if code := getStatus(t, m.AvatarUrl); code != http.StatusOK {
				t.Fatalf("GET avatar: %d", code)
			}
		}
	}
	signed(must2(set(ana, e.url+pic.Url))) // its own absolute URL echoed back

	var stored string
	e.s.db.r.QueryRow("SELECT avatar_url FROM members WHERE username = 'ana'").Scan(&stored)
	if stored != "/files/"+pic.Id+"/me.png" {
		t.Fatalf("stored %q", stored)
	}

	exists := func(id string) bool {
		var n int
		e.s.db.r.QueryRow("SELECT COUNT(*) FROM attachments WHERE id = ?", id).Scan(&n)
		return n == 1
	}
	e.clock.Advance(25 * time.Hour)
	ana = e.client(e.token("ana")) // the old token expired
	if err := e.s.prune(ctx()); err != nil || !exists(pic.Id) || exists(txt.Id) {
		t.Fatalf("prune: %v, avatar %v, txt %v", err, exists(pic.Id), exists(txt.Id))
	}
	if m := must2(set(ana, "https://auth.test/a/1.png")); m.AvatarUrl != "https://auth.test/a/1.png" {
		t.Fatalf("outside avatar = %q", m.AvatarUrl)
	}
	if err := e.s.prune(ctx()); err != nil || exists(pic.Id) {
		t.Fatalf("prune after reset: %v, avatar %v", err, exists(pic.Id))
	}
}
