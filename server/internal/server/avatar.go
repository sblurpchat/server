package server

import (
	"context"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// Member.avatar_url is an outside http(s) URL (the sblurp.chat picture shared
// at join) or, for a picture uploaded to this server, "/files/{id}/{name}" in
// the database. signURLs turns the second form into a signed absolute URL in
// every response and event, so clients just show it (1042).

// localAvatar reports whether v names an upload on this server: a path under
// /files/, alone or under BaseURL, with or without a query. It returns the id.
func (s *Server) localAvatar(v string) (string, bool) {
	p, ok := strings.CutPrefix(strings.TrimPrefix(v, s.cfg.BaseURL), "/files/")
	id, _, _ := strings.Cut(p, "/")
	return id, ok
}

// avatarPath checks that id is the caller's own unsent image upload and
// returns the path to store in members.avatar_url.
func avatarPath(ctx context.Context, q queryer, id, member string) (string, error) {
	if id == "" {
		return "", errf(connect.CodeInvalidArgument, "upload the image first")
	}
	if err := checkBannerUpload(ctx, q, id, member); err != nil {
		return "", err
	}
	var name string
	if err := q.QueryRowContext(ctx, "SELECT name FROM attachments WHERE id = ?", id).Scan(&name); err != nil {
		return "", err
	}
	return fileURL(id, name), nil
}

// signAvatar rewrites a stored "/files/{id}/{name}" avatar as a signed
// absolute URL. Anything else is left alone, so signing twice is harmless.
func (s *Server) signAvatar(m *v1.Member, now time.Time) {
	p, ok := strings.CutPrefix(m.AvatarUrl, "/files/")
	if !ok {
		return
	}
	id, esc, _ := strings.Cut(p, "/")
	name, err := url.PathUnescape(esc)
	if err != nil {
		return
	}
	m.AvatarUrl = s.cfg.BaseURL + signedFileURL(s.fileKey, id, name, now)
}
