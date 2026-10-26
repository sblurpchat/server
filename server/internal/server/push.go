package server

// Push notifications (ticket 0110; design in docs/ARCHITECTURE.md). A
// member's access token can carry an opaque push handle from their account
// server. When a message mentions them, or arrives in their DM, and they
// have no open Subscribe stream, the server posts the handle to
// {their iss}/api/push/send. It never learns device tokens.

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

var mentionIDRE = regexp.MustCompile(`<@([A-Za-z0-9_-]{1,64})>`)

// pushCandidates is who a message may notify: everyone else in a DM, or the
// members it mentions. The caller still checks handles, presence and blocks.
func pushCandidates(dm bool, text, author string, dmMembers []string) (ids []string, kind string) {
	if dm {
		ids, kind = dmMembers, "dm"
	} else {
		for _, m := range mentionIDRE.FindAllStringSubmatch(text, -1) {
			ids = append(ids, m[1])
		}
		kind = "mention"
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	return slices.DeleteFunc(ids, func(id string) bool { return id == author }), kind
}

// rememberPush stores the push claims from a member's token when they change.
func (s *Server) rememberPush(ctx context.Context, member, handle string, preview bool) {
	if handle == "" { // tokens from other clients carry none; keep the last one
		return
	}
	key := handle
	if preview {
		key += " preview"
	}
	if v, ok := s.pushSeen.Load(member); ok && v == key {
		return
	}
	err := s.writeTx(ctx, func(t *wtx) error {
		_, err := t.ExecContext(ctx, "UPDATE members SET push_handle = ?, push_preview = ? WHERE id = ?", handle, preview, member)
		return err
	})
	if err != nil {
		s.log.Warn("push handle not saved", "member", member, "err", err)
		return
	}
	s.pushSeen.Store(member, key)
}

// pushMessage queues pushes for a new message. It never blocks the sender:
// a full queue drops the pushes.
func (s *Server) pushMessage(author string, msg *v1.Message) {
	select {
	case s.pushJobs <- func() { s.sendPushes(author, msg) }:
	default:
		s.log.Warn("push queue full, dropping pushes", "message", msg.Id)
	}
}

func (s *Server) pushLoop() {
	defer s.wg.Done()
	for {
		select {
		case <-s.stop:
			return
		case job := <-s.pushJobs:
			job()
		}
	}
}

type pushBody struct {
	Handle    string `json:"handle"`
	Kind      string `json:"kind"`
	Community string `json:"community"`
	Channel   string `json:"channel"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	From      string `json:"from,omitempty"`
	Text      string `json:"text,omitempty"`
}

func (s *Server) sendPushes(authorID string, msg *v1.Message) {
	ctx := context.Background()
	author, err := s.loadMember(ctx, s.db.r, "id = ?", authorID)
	if err != nil || author == nil {
		return
	}
	c, err := channelFor(ctx, s.db.r, msg.ChannelId, author.Id)
	if err != nil {
		return
	}
	dm := c.Kind == v1.ChannelKind_CHANNEL_KIND_DM
	var members []string
	if dm {
		var key string
		if s.db.r.QueryRowContext(ctx, "SELECT dm_key FROM channels WHERE id = ?", c.Id).Scan(&key) != nil {
			return
		}
		members = strings.Split(key, ",")
	}
	ids, kind := pushCandidates(dm, msg.Text, author.Id, members)
	for _, id := range ids {
		if s.hub.isOnline(id) {
			continue
		}
		var iss, handle string
		var preview bool
		err := s.db.r.QueryRowContext(ctx, `SELECT iss, push_handle, push_preview FROM members m WHERE id = ?1 AND push_handle != ''
			AND kind = ?2 AND deleted = 0
			AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?3)
			AND NOT EXISTS (SELECT 1 FROM mutes WHERE muter_id = ?1 AND muted_id = ?3)`,
			id, v1.MemberKind_MEMBER_KIND_HUMAN, author.Id).Scan(&iss, &handle, &preview)
		if err != nil {
			continue // no handle, a bot, gone, or they blocked or muted the author
		}
		if !dm {
			if _, err := channelFor(ctx, s.db.r, c.Id, id); err != nil {
				continue // mentioned in a channel they cannot see
			}
		}
		if l, err := notifyLevel(ctx, s.db.r, id, c); err != nil || l == v1.NotifyLevel_NOTIFY_LEVEL_NOTHING {
			continue // they silenced this channel or the community
		}
		b := pushBody{Handle: handle, Kind: kind, Community: s.cfg.Name, Channel: c.Name, ChannelID: c.Id, MessageID: msg.Id}
		if preview {
			b.From = cmp.Or(author.DisplayName, author.Username)
			b.Text = s.mentionNames(ctx, msg.Text)
		}
		s.postPush(id, iss, b)
	}
}

// mentionNames shows <@id> as @username, the way clients render it.
func (s *Server) mentionNames(ctx context.Context, text string) string {
	return mentionIDRE.ReplaceAllStringFunc(text, func(m string) string {
		var name string
		if s.db.r.QueryRowContext(ctx, "SELECT username FROM members WHERE id = ?", m[2:len(m)-1]).Scan(&name) != nil {
			return m
		}
		return "@" + name
	})
}

func (s *Server) postPush(member, iss string, b pushBody) {
	body, _ := json.Marshal(b)
	res, err := s.cfg.HTTPClient.Post(strings.TrimRight(iss, "/")+"/api/push/send", "application/json", bytes.NewReader(body))
	if err != nil {
		s.log.Warn("push failed", "member", member, "err", err)
		return
	}
	res.Body.Close()
	switch res.StatusCode {
	case http.StatusAccepted:
	case http.StatusGone: // no devices left: forget the handle until a token brings a new one
		s.pushSeen.Delete(member)
		s.writeTx(context.Background(), func(t *wtx) error {
			_, err := t.ExecContext(t.ctx, "UPDATE members SET push_handle = '' WHERE id = ? AND push_handle = ?", member, b.Handle)
			return err
		})
	default:
		s.log.Warn("push refused", "member", member, "status", res.StatusCode)
	}
}
