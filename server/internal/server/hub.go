package server

import (
	"sync"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// hub fans live events out to open subscriptions. publish never blocks: a
// subscriber whose buffer is full is dropped and must reconnect. Presence
// does not use the buffer: each sub keeps the latest presence per member,
// so a reconnect burst coalesces instead of dropping subscribers (1060).
type hub struct {
	mu     sync.Mutex
	subs   map[*sub]bool
	online map[string]int // member id -> open subscriptions
	now    func() int64
}

type sub struct {
	member string
	ch     chan *v1.Event
	gone   chan struct{} // closed when dropped for being slow
	wake   chan struct{} // signalled when pres has news
	// ponytail: one entry per changed member, so at most the online count
	// per sub; a stalled client holds that much until it is dropped.
	pres map[string]*v1.Event // guarded by hub.mu
}

const subBuffer = 512

func newHub(now func() int64) *hub {
	return &hub{subs: map[*sub]bool{}, online: map[string]int{}, now: now}
}

func (h *hub) add(member string) *sub {
	s := &sub{member: member, ch: make(chan *v1.Event, subBuffer), gone: make(chan struct{}), wake: make(chan struct{}, 1)}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[s] = true
	h.online[member]++
	if h.online[member] == 1 {
		h.presenceLocked(member, v1.Presence_PRESENCE_ONLINE)
	}
	return s
}

func (h *hub) remove(s *sub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(s)
}

func (h *hub) removeLocked(s *sub) {
	if !h.subs[s] {
		return
	}
	delete(h.subs, s)
	h.online[s.member]--
	if h.online[s.member] == 0 {
		delete(h.online, s.member)
		h.presenceLocked(s.member, v1.Presence_PRESENCE_OFFLINE)
	}
}

func (h *hub) presenceLocked(member string, p v1.Presence) {
	ev := &v1.Event{AtMs: h.now(), Kind: &v1.Event_Presence{Presence: &v1.PresenceEvent{MemberId: member, Presence: p}}}
	for s := range h.subs {
		if s.pres == nil {
			s.pres = map[string]*v1.Event{}
		}
		s.pres[member] = ev
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

// takePresence returns and clears the presence changes waiting for s.
func (h *hub) takePresence(s *sub) map[string]*v1.Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := s.pres
	s.pres = nil
	return p
}

// publish sends ev to every subscriber in audience (nil = everyone).
func (h *hub) publish(ev *v1.Event, audience map[string]bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var slow []*sub
	for s := range h.subs {
		if audience != nil && !audience[s.member] {
			continue
		}
		select {
		case s.ch <- ev:
		default:
			slow = append(slow, s)
		}
	}
	for _, s := range slow {
		if h.subs[s] {
			close(s.gone)
			h.removeLocked(s)
		}
	}
}

func (h *hub) isOnline(member string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.online[member] > 0
}

// closeAll ends every subscription, for shutdown. Clients reconnect.
func (h *hub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		close(s.gone)
		delete(h.subs, s)
	}
	clear(h.online)
}

// drop ends every subscription of one member, e.g. after a kick.
func (h *hub) drop(member string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if s.member == member {
			close(s.gone)
			h.removeLocked(s)
		}
	}
}
