package server

import (
	"sync"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// hub fans live events out to open subscriptions. publish never blocks: a
// subscriber whose buffer is full is dropped and must reconnect.
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
}

const subBuffer = 512

func newHub(now func() int64) *hub {
	return &hub{subs: map[*sub]bool{}, online: map[string]int{}, now: now}
}

func (h *hub) add(member string) *sub {
	s := &sub{member: member, ch: make(chan *v1.Event, subBuffer), gone: make(chan struct{})}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[s] = true
	h.online[member]++
	if h.online[member] == 1 {
		h.publishLocked(presenceEvent(member, v1.Presence_PRESENCE_ONLINE, h.now()), nil)
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
		h.publishLocked(presenceEvent(s.member, v1.Presence_PRESENCE_OFFLINE, h.now()), nil)
	}
}

func presenceEvent(member string, p v1.Presence, at int64) *v1.Event {
	return &v1.Event{AtMs: at, Kind: &v1.Event_Presence{Presence: &v1.PresenceEvent{MemberId: member, Presence: p}}}
}

// publish sends ev to every subscriber in audience (nil = everyone).
func (h *hub) publish(ev *v1.Event, audience map[string]bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.publishLocked(ev, audience)
}

func (h *hub) publishLocked(ev *v1.Event, audience map[string]bool) {
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
		if h.subs[s] { // removing publishes presence, which may drop it first
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
