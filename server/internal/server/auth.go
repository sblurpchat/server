package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

// claims are the JWT claims the server uses.
type claims struct {
	Iss           string   `json:"iss"`
	Sub           string   `json:"sub"`
	Aud           audience `json:"aud"`
	Exp           int64    `json:"exp"`
	Iat           int64    `json:"iat"`
	Nbf           int64    `json:"nbf"`
	Username      string   `json:"preferred_username"`
	EmailVerified bool     `json:"email_verified"`
	AgeOver13     bool     `json:"age_over_13"`
	AgeOver18     bool     `json:"age_over_18"`
	Push          string   `json:"push"`         // opaque push handle from the issuer (push.go)
	PushPreview   bool     `json:"push_preview"` // the member wants message text in pushes
}

// audience accepts the JWT "aud" as a string or a list of strings.
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*a = audience{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

const clockSkew = 60 * time.Second

var b64 = base64.RawURLEncoding

// verifyJWT checks an EdDSA JWT. It is pure: the key lookup is passed in, so
// tests can call it without a network. The issuer is checked against the
// trusted list before any key lookup, so an attacker cannot make the server
// fetch keys from a URL of their choice.
func verifyJWT(token string, trusted []string, aud string, now time.Time,
	key func(iss, kid string) (ed25519.PublicKey, error)) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	hb, err := b64.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &hdr) != nil {
		return nil, errors.New("malformed token header")
	}
	if hdr.Alg != "EdDSA" {
		return nil, fmt.Errorf("unsupported alg %q", hdr.Alg)
	}
	pb, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("malformed token payload")
	}
	var c claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, errors.New("malformed token claims")
	}
	iss := strings.TrimRight(c.Iss, "/")
	if iss == "" || !slices.ContainsFunc(trusted, func(t string) bool { return strings.TrimRight(t, "/") == iss }) {
		return nil, fmt.Errorf("untrusted issuer %q", c.Iss)
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, errors.New("malformed signature")
	}
	pub, err := key(iss, hdr.Kid)
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, errors.New("bad signature")
	}
	if !slices.ContainsFunc(c.Aud, func(a string) bool { return strings.TrimRight(a, "/") == strings.TrimRight(aud, "/") }) {
		return nil, errors.New("token audience is not this server")
	}
	switch {
	case c.Exp == 0 || now.After(time.Unix(c.Exp, 0).Add(clockSkew)):
		return nil, errors.New("token expired")
	case c.Iat == 0 || time.Unix(c.Iat, 0).After(now.Add(clockSkew)):
		return nil, errors.New("token issued in the future")
	case c.Nbf != 0 && time.Unix(c.Nbf, 0).After(now.Add(clockSkew)):
		return nil, errors.New("token not valid yet")
	case c.Sub == "":
		return nil, errors.New("token has no subject")
	}
	c.Iss = iss
	return &c, nil
}

// jwks caches each trusted issuer's keys. An unknown kid triggers a refetch,
// at most once per refetchEvery per issuer, so junk tokens cannot hammer the
// issuer.
type jwks struct {
	client *http.Client
	now    func() time.Time
	mu     sync.Mutex // guards byIss only
	byIss  map[string]*issuerKeys
}

type issuerKeys struct {
	mu      sync.Mutex // held across a fetch, so only this issuer waits
	keys    map[string]ed25519.PublicKey
	fetched time.Time // last successful fetch
	tried   time.Time // last attempt
}

const (
	jwksMaxAge   = time.Hour
	refetchEvery = 30 * time.Second
)

// key returns an issuer's key. j.mu guards only the map; each issuer has
// its own lock, so a slow issuer stalls only its own tokens.
func (j *jwks) key(iss, kid string) (ed25519.PublicKey, error) {
	j.mu.Lock()
	ik := j.byIss[iss]
	if ik == nil {
		ik = &issuerKeys{}
		j.byIss[iss] = ik
	}
	j.mu.Unlock()
	ik.mu.Lock()
	defer ik.mu.Unlock()
	now := j.now()
	k, have := ik.keys[kid]
	if have && now.Sub(ik.fetched) < jwksMaxAge {
		return k, nil
	}
	if now.Sub(ik.tried) >= refetchEvery {
		ik.tried = now
		keys, err := fetchJWKS(j.client, iss+"/.well-known/jwks.json")
		if err == nil {
			ik.keys, ik.fetched = keys, now
			k, have = keys[kid]
		}
	}
	if !have {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	return k, nil
}

func fetchJWKS(c *http.Client, url string) (map[string]ed25519.PublicKey, error) {
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks: %s", resp.Status)
	}
	var set struct {
		Keys []struct {
			Kty, Crv, X, Kid string
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return nil, err
	}
	keys := map[string]ed25519.PublicKey{}
	for _, k := range set.Keys {
		x, err := b64.DecodeString(k.X)
		if k.Kty == "OKP" && k.Crv == "Ed25519" && err == nil && len(x) == ed25519.PublicKeySize {
			keys[k.Kid] = ed25519.PublicKey(x)
		}
	}
	return keys, nil
}

// Bot tokens: "sbb_" + 32 random bytes. Only the SHA-256 is stored.
const botPrefix = "sbb_"

func newBotToken() (token, hash string) {
	b := make([]byte, 32)
	rand.Read(b)
	token = botPrefix + b64.EncodeToString(b)
	return token, hashToken(token)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// identity is who made a request. member is nil for a person who has not
// joined yet.
type identity struct {
	iss, sub, username                  string
	emailVerified, ageOver13, ageOver18 bool // claims, passed to plugins
	member                              *memberRow
}

type ctxKey struct{}

func callerFrom(ctx context.Context) *identity {
	id, _ := ctx.Value(ctxKey{}).(*identity)
	return id
}

// me returns the calling member. The interceptor guarantees it is set for
// every procedure except GetServerInfo and Join.
func me(ctx context.Context) *memberRow { return callerFrom(ctx).member }

func (s *Server) authenticate(ctx context.Context, header string) (*identity, error) {
	tok, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || tok == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing bearer token"))
	}
	if strings.HasPrefix(tok, botPrefix) {
		m, err := s.loadMember(ctx, s.db.r, "token_hash = ? AND deleted = 0", hashToken(tok))
		if err != nil {
			return nil, err
		}
		if m == nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid bot token"))
		}
		return &identity{member: m}, nil
	}
	c, err := verifyJWT(tok, s.cfg.TrustedIssuers, s.cfg.BaseURL, s.now(), s.jwks.key)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	m, err := s.loadMember(ctx, s.db.r, "iss = ? AND sub = ? AND deleted = 0", c.Iss, c.Sub)
	if err != nil {
		return nil, err
	}
	id := &identity{iss: c.Iss, sub: c.Sub, username: c.Username, member: m,
		emailVerified: c.EmailVerified, ageOver13: c.AgeOver13, ageOver18: c.AgeOver18}
	if m != nil {
		s.rememberPush(ctx, m.Id, c.Push, c.PushPreview)
	}
	if m != nil && m.claim != c.Username {
		if fresh, err := s.syncUsername(ctx, id); err != nil {
			s.log.Warn("username sync failed", "member", m.Id, "err", err)
		} else if fresh != nil {
			id.member = fresh
		}
	}
	return id, nil
}

// authorize decides whether an identity may call a procedure.
func authorize(procedure string, id *identity) error {
	switch {
	case procedure == sblurpv1connect.ServerServiceGetServerInfoProcedure:
		return nil
	case id == nil:
		return connect.NewError(connect.CodeUnauthenticated, errors.New("missing bearer token"))
	case procedure == sblurpv1connect.ServerServiceJoinProcedure:
		return nil
	case id.member == nil:
		return connect.NewError(connect.CodePermissionDenied, errors.New("join this community first"))
	}
	return nil
}

// interceptor authenticates every call and stores the identity in the
// context. GetServerInfo needs no token.
type interceptor struct{ s *Server }

func (i interceptor) check(ctx context.Context, procedure string, h http.Header) (context.Context, error) {
	var id *identity
	if procedure != sblurpv1connect.ServerServiceGetServerInfoProcedure {
		var err error
		if id, err = i.s.authenticate(ctx, h.Get("Authorization")); err != nil {
			return ctx, err
		}
	}
	if err := authorize(procedure, id); err != nil {
		return ctx, err
	}
	if id != nil && id.member != nil {
		if err := i.s.rateLimit(procedure, id.member); err != nil {
			return ctx, err
		}
	}
	return context.WithValue(ctx, ctxKey{}, id), nil
}

func (i interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		ctx, err := i.check(ctx, req.Spec().Procedure, req.Header())
		if err != nil {
			return nil, err
		}
		res, err := next(ctx, req)
		if err == nil {
			if m, ok := res.Any().(proto.Message); ok {
				i.s.signURLs(m)
			}
		}
		return res, err
	}
}

func (i interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (i interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		ctx, err := i.check(ctx, conn.Spec().Procedure, conn.RequestHeader())
		if err != nil {
			return err
		}
		return next(ctx, signingConn{conn, i.s})
	}
}

// signingConn signs attachment URLs in streamed events. Live events are
// shared by every subscriber, so it signs a copy.
type signingConn struct {
	connect.StreamingHandlerConn
	s *Server
}

func (c signingConn) Send(m any) error {
	if pm, ok := m.(proto.Message); ok {
		pm = proto.Clone(pm)
		c.s.signURLs(pm)
		m = pm
	}
	return c.StreamingHandlerConn.Send(m)
}
