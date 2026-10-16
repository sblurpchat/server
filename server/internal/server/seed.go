package server

import (
	"cmp"
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	v1 "sblurp.chat/server/gen/sblurp/v1"
	"sblurp.chat/server/internal/seed"
)

var mentionRE = regexp.MustCompile(`@([a-z0-9_.-]+)`)

// seed fills an empty database with a demo community. Seeded people have no
// login; they exist so the UI looks alive. The bot's token goes to
// <data>/bot-token.txt so the example bot can run as it.
func (s *Server) seed(ctx context.Context, name string) error {
	c, ok := seed.Get(name)
	if !ok {
		return fmt.Errorf("unknown seed %q (want community or owls)", name)
	}
	s.cfg.Description = cmp.Or(s.cfg.Description, c.Description)
	s.cfg.Accent = cmp.Or(s.cfg.Accent, c.Accent)
	var members int
	if err := s.db.r.QueryRowContext(ctx, "SELECT COUNT(*) FROM members").Scan(&members); err != nil || members > 0 {
		return err
	}
	now := s.now()
	rng := rand.New(rand.NewPCG(7, 7))
	ids := map[string]string{} // username -> member id
	var token string
	err := s.writeTx(ctx, func(t *wtx) error {
		for i, m := range c.Members {
			role := map[string]v1.MemberRole{"admin": v1.MemberRole_MEMBER_ROLE_ADMIN, "moderator": v1.MemberRole_MEMBER_ROLE_MODERATOR}[m.Role]
			role = cmp.Or(role, v1.MemberRole_MEMBER_ROLE_MEMBER)
			joined := now.Add(-30*24*time.Hour + time.Duration(i)*7*time.Hour)
			ids[m.Username] = newID(joined)
			if _, err := t.ExecContext(ctx, `INSERT INTO members(id, kind, role, username, display_name, bio, status_text, status_emoji, joined_at_ms)
				VALUES (?,?,?,?,?,?,?,?,?)`, ids[m.Username], v1.MemberKind_MEMBER_KIND_HUMAN, role, m.Username, m.Display, m.Bio,
				m.Status, m.Emoji, joined.UnixMilli()); err != nil {
				return err
			}
		}
		bot, tok, err := s.createBot(t, c.Bot.Username, c.Bot.Display, "", c.Bot.Bio, now.Add(-20*24*time.Hour))
		if err != nil {
			return err
		}
		ids[c.Bot.Username], token = bot.Id, tok

		type line struct {
			at      time.Time
			channel string
			l       seed.Line
			parent  *line
			id      string
		}
		var lines []*line
		addConvos := func(channel string, convos []seed.Convo) {
			for _, cv := range convos {
				var batch []*line
				at := now.Add(-time.Duration(cv.DaysAgo * float64(24*time.Hour)))
				for _, l := range cv.Lines {
					at = at.Add(time.Duration(1+rng.IntN(7))*time.Minute + time.Duration(rng.IntN(60))*time.Second)
					p := &line{at: at, channel: channel, l: l}
					batch = append(batch, p)
					rt := at
					for _, r := range l.Replies {
						rt = rt.Add(time.Duration(2+rng.IntN(25)) * time.Minute)
						batch = append(batch, &line{at: rt, channel: channel, l: r, parent: p})
					}
				}
				// Keep the newest line a little in the past.
				latest := slices.MaxFunc(batch, func(a, b *line) int { return a.at.Compare(b.at) }).at
				if shift := latest.Sub(now.Add(-3 * time.Minute)); shift > 0 {
					for _, b := range batch {
						b.at = b.at.Add(-shift)
					}
				}
				lines = append(lines, batch...)
			}
		}
		for _, ch := range c.Channels {
			kind := v1.ChannelKind_CHANNEL_KIND_TEXT
			var mids []string
			if ch.Private {
				kind = v1.ChannelKind_CHANNEL_KIND_PRIVATE
				for _, u := range ch.Members {
					mids = append(mids, ids[u])
				}
			}
			created, err := s.createChannel(t, kind, ch.Name, ch.Topic, ch.Category, "", mids)
			if err != nil {
				return fmt.Errorf("channel %s: %w", ch.Name, err)
			}
			addConvos(created.Id, ch.Convos)
		}
		for _, dm := range c.DMs {
			var mids []string
			for _, u := range dm.Members {
				mids = append(mids, ids[u])
			}
			slices.Sort(mids)
			created, err := s.createChannel(t, v1.ChannelKind_CHANNEL_KIND_DM, "", "", "", strings.Join(mids, ","), mids)
			if err != nil {
				return err
			}
			addConvos(created.Id, dm.Convos)
		}

		// Insert in time order so seq order matches time order.
		slices.SortStableFunc(lines, func(a, b *line) int { return a.at.Compare(b.at) })
		for _, l := range lines {
			author, ok := ids[l.l.By]
			if !ok {
				return fmt.Errorf("unknown author %q", l.l.By)
			}
			text := mentionRE.ReplaceAllStringFunc(l.l.Text, func(m string) string {
				u := strings.TrimRight(m[1:], ".-")
				if id, ok := ids[u]; ok {
					return "<@" + id + ">" + m[1+len(u):]
				}
				return m
			})
			req := &v1.SendMessageRequest{ChannelId: l.channel, Text: text}
			if l.parent != nil {
				req.ThreadRootId = l.parent.id
			}
			msg, err := s.sendMessage(t, author, req, l.at)
			if err != nil {
				return fmt.Errorf("message by %s: %w", l.l.By, err)
			}
			l.id = msg.Id
			for emoji, users := range l.l.React {
				for _, u := range users {
					if _, err := t.ExecContext(ctx, "INSERT OR IGNORE INTO reactions(message_id, emoji, member_id, at_ms) VALUES (?,?,?,?)",
						msg.Id, emoji, ids[u], l.at.Add(time.Minute).UnixMilli()); err != nil {
						return err
					}
				}
			}
		}
		s.log.Info("seeded demo community", "seed", name, "members", len(c.Members), "channels", len(c.Channels), "messages", len(lines))
		return nil
	})
	if err != nil {
		return err
	}
	path := filepath.Join(s.cfg.DataDir, "bot-token.txt")
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	s.log.Info("wrote seeded bot token", "bot", c.Bot.Username, "path", path)
	return nil
}
