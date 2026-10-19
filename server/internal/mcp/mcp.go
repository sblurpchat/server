// Package mcp serves the Model Context Protocol at /mcp, so an agent such as
// Claude Code can read and post in this community as the person who signed
// in. Transport: Streamable HTTP, one JSON response per POST, no sessions and
// no server-sent events. Authorization: OAuth 2.1 with the trusted issuers as
// authorization servers (RFC 9728 metadata at /.well-known/oauth-protected-resource).
//
// Every tool calls the community's own Connect API in process with the
// caller's bearer token. The interceptor checks the token (issuer, signature,
// audience = this server) and every permission, block and rate limit applies
// exactly as in the app. A bot token works too: the agent then acts as that
// bot, under the bot rate limit (TestBotRateLimit).
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
	"sblurp.chat/server/gen/sblurp/v1/sblurpv1connect"
)

// versions are the MCP revisions this server speaks, newest first.
var versions = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

type Handler struct {
	base    string // community base URL: the token audience and the OAuth resource
	issuers []string
	version string
	srv     sblurpv1connect.ServerServiceClient
	chat    sblurpv1connect.ChatServiceClient
}

// New returns the MCP handler. api is the server's own HTTP handler; tools
// call its Connect services in process.
func New(base string, issuers []string, version string, api http.Handler) *Handler {
	hc := &http.Client{Transport: inproc{api}}
	return &Handler{base: strings.TrimRight(base, "/"), issuers: issuers, version: version,
		srv:  sblurpv1connect.NewServerServiceClient(hc, "http://in-process"),
		chat: sblurpv1connect.NewChatServiceClient(hc, "http://in-process")}
}

// Mount adds /mcp and the protected resource metadata to mux.
func (h *Handler) Mount(mux *http.ServeMux) {
	mux.HandleFunc("POST /mcp", h.serve)
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST") // no SSE stream to GET, no session to DELETE
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	// The root document, and the path-aware one clients try first for /mcp.
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", h.metadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", h.metadata)
}

// inproc sends a request straight to a handler, without a network.
type inproc struct{ h http.Handler }

func (t inproc) RoundTrip(r *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.h.ServeHTTP(rec, r)
	return rec.Result(), nil
}

func (h *Handler) metadata(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	json.NewEncoder(w).Encode(map[string]any{
		// The whole server is one resource: a token for the community works at
		// /mcp and at the Connect API alike.
		"resource":                 h.base,
		"authorization_servers":    h.issuers,
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Sblurp community",
		"resource_documentation":   "https://sblurp.chat/docs/mcp",
	})
}

type rpcReq struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	if v := r.Header.Get("MCP-Protocol-Version"); v != "" && !slices.Contains(versions, v) {
		http.Error(w, "unsupported MCP-Protocol-Version", http.StatusBadRequest)
		return
	}
	auth := r.Header.Get("Authorization")
	_, err := h.srv.GetMe(r.Context(), withAuth(auth, &v1.GetMeRequest{}))
	if code := connect.CodeOf(err); code == connect.CodeUnauthenticated {
		challenge := `Bearer resource_metadata="` + h.base + `/.well-known/oauth-protected-resource"`
		if auth != "" {
			challenge += `, error="invalid_token"`
		}
		w.Header().Set("WWW-Authenticate", challenge)
		http.Error(w, "sign in with your Sblurp account", http.StatusUnauthorized)
		return
	} else if err != nil && code != connect.CodePermissionDenied { // PermissionDenied: signed in, not joined yet
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	var req rpcReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeRPC(w, nil, nil, &rpcErr{-32700, "parse error"})
		return
	}
	if len(req.ID) == 0 || string(req.ID) == "null" { // a notification or a response: nothing to answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	res, rerr := h.dispatch(r.Context(), auth, req)
	writeRPC(w, req.ID, res, rerr)
}

func writeRPC(w http.ResponseWriter, id json.RawMessage, result any, e *rpcErr) {
	if id == nil {
		id = json.RawMessage("null")
	}
	out := map[string]any{"jsonrpc": "2.0", "id": id}
	if e != nil {
		out["error"] = e
	} else {
		out["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// negotiate picks the protocol version to answer initialize with: the
// client's if we speak it, else our newest.
func negotiate(asked string) string {
	if slices.Contains(versions, asked) {
		return asked
	}
	return versions[0]
}

func (h *Handler) dispatch(ctx context.Context, auth string, req rpcReq) (any, *rpcErr) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		info := map[string]any{"name": "sblurp", "title": "Sblurp", "version": h.version}
		community := "one Sblurp community"
		if si, err := h.srv.GetServerInfo(ctx, withAuth("", &v1.GetServerInfoRequest{})); err == nil {
			info["title"], community = si.Msg.Name, "the Sblurp community \""+si.Msg.Name+"\""
		}
		instructions := "Tools for " + community + ". You act as the person who signed in: everything you post appears under their name, so do not post anything they did not ask for."
		return map[string]any{"protocolVersion": negotiate(p.ProtocolVersion), "serverInfo": info,
			"capabilities": map[string]any{"tools": map[string]any{}}, "instructions": instructions}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		list := make([]map[string]any, len(tools))
		for i, t := range tools {
			list[i] = map[string]any{"name": t.name, "description": t.desc, "inputSchema": t.schema,
				"annotations": map[string]any{"readOnlyHint": t.readOnly, "openWorldHint": false}}
		}
		return map[string]any{"tools": list}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcErr{-32602, "invalid params"}
		}
		i := slices.IndexFunc(tools, func(t tool) bool { return t.name == p.Name })
		if i < 0 {
			return nil, &rpcErr{-32602, "unknown tool " + p.Name}
		}
		text, err := tools[i].run(ctx, &call{h: h, auth: auth, args: p.Arguments})
		if err != nil {
			return map[string]any{"content": []map[string]any{{"type": "text", "text": errText(err)}}, "isError": true}, nil
		}
		return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}, nil
	}
	return nil, &rpcErr{-32601, "method not found: " + req.Method}
}

// errText is what the agent reads when a tool fails.
func errText(err error) string {
	var ce *connect.Error
	if errors.As(err, &ce) {
		if ce.Code() == connect.CodePermissionDenied && ce.Message() == "join this community first" {
			return "You have not joined this community yet. Join it in the Sblurp app first, then try again."
		}
		return ce.Message()
	}
	return err.Error()
}

func withAuth[T any](auth string, m *T) *connect.Request[T] {
	r := connect.NewRequest(m)
	if auth != "" {
		r.Header().Set("Authorization", auth)
	}
	return r
}
