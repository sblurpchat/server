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
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

// claims are the JWT claims the server uses.
type claims struct {
	Iss      string   `json:"iss"`
	Sub      string   `json:"sub"`
	Aud      audience `json:"aud"`
	Exp      int64    `json:"exp"`
	Iat      int64    `json:"iat"`
	Nbf      int64    `json:"nbf"`
	Username string   `json:"preferred_username"`
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
	ok := false
	for _, t := range trusted {
		if strings.TrimRight(t, "/") == iss && iss != "" {
			ok = true
		}
	}
	if !ok {
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
	audOK := false
	for _, a := range c.Aud {
		if strings.TrimRight(a, "/") == strings.TrimRight(aud, "/") {
			audOK = true
		}
	}
	if !audOK {
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
	mu     sync.Mutex
	byIss  map[string]*issuerKeys
}

type issuerKeys struct {
	keys    map[string]ed25519.PublicKey
	fetched time.Time // last successful fetch
	tried   time.Time // last attempt
}

const (
	jwksMaxAge   = time.Hour
	refetchEvery = 30 * time.Second
)

// ponytail: one lock across the fetch serializes verification during a
// refetch (5s timeout, rate limited); per-issuer singleflight if it matters.
func (j *jwks) key(iss, kid string) (ed25519.PublicKey, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	ik := j.byIss[iss]
	if ik == nil {
		ik = &issuerKeys{}
		j.byIss[iss] = ik
	}
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
	iss, sub, username string
	member             *memberRow
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
	return &identity{iss: c.Iss, sub: c.Sub, username: c.Username, member: m}, nil
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
	return context.WithValue(ctx, ctxKey{}, id), nil
}

func (i interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		ctx, err := i.check(ctx, req.Spec().Procedure, req.Header())
		if err != nil {
			return nil, err
		}
		return next(ctx, req)
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
		return next(ctx, conn)
	}
}
