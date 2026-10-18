package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "sblurp.chat/server/gen/sblurp/v1"
)

// mcpCall posts one JSON-RPC request to /mcp and returns the status, the
// response and the WWW-Authenticate header.
func (e *env) mcpCall(tok, method string, params any) (int, map[string]any, string) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": method, "params": params})
	req, _ := http.NewRequest("POST", e.url+"/mcp", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out, res.Header.Get("WWW-Authenticate")
}

// tool calls an MCP tool and returns its text and isError.
func (e *env) tool(tok, name string, args map[string]any) (string, bool) {
	e.t.Helper()
	st, out, _ := e.mcpCall(tok, "tools/call", map[string]any{"name": name, "arguments": args})
	r, ok := out["result"].(map[string]any)
	if st != 200 || !ok {
		e.t.Fatalf("%s: %d %v", name, st, out)
	}
	isErr, _ := r["isError"].(bool)
	return r["content"].([]any)[0].(map[string]any)["text"].(string), isErr
}

func TestMCP(t *testing.T) {
	e := newEnv(t)
	alice := e.join("alice") // the owner
	bob := e.join("bob")
	general := alice.channel("general", v1.ChannelKind_CHANNEL_KIND_TEXT)
	secret := alice.channel("secret", v1.ChannelKind_CHANNEL_KIND_PRIVATE)
	alice.send(secret.Id, "the cake is in the fridge")
	alice.send(general.Id, "hello <@"+bob.me.Id+">")

	// The protected resource metadata names the trusted issuer.
	res, err := http.Get(e.url + "/.well-known/oauth-protected-resource")
	if err != nil {
		t.Fatal(err)
	}
	var prm map[string]any
	json.NewDecoder(res.Body).Decode(&prm)
	res.Body.Close()
	if prm["resource"] != e.url || prm["authorization_servers"].([]any)[0] != e.iss.url {
		t.Fatalf("metadata: %v", prm)
	}

	// No token, a bad token, or a token for another server: 401 that points at the metadata.
	other := e.claims("bob")
	other["aud"] = "https://elsewhere.example"
	for _, tok := range []string{"", "junk", signJWT(e.iss.key, map[string]any{"alg": "EdDSA", "kid": e.iss.kid}, other)} {
		st, _, www := e.mcpCall(tok, "initialize", map[string]any{})
		if st != 401 || !strings.Contains(www, `resource_metadata="`+e.url+`/.well-known/oauth-protected-resource"`) {
			t.Fatalf("token %.10q: %d %q", tok, st, www)
		}
	}
	if res, _ := http.Get(e.url + "/mcp"); res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /mcp: %d", res.StatusCode)
	}

	tok := bob.tok
	st, out, _ := e.mcpCall(tok, "initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "1"}})
	r := out["result"].(map[string]any)
	if st != 200 || r["protocolVersion"] != "2025-06-18" || r["serverInfo"].(map[string]any)["title"] != "Test" {
		t.Fatalf("initialize: %d %v", st, out)
	}
	// A notification gets 202 and no body.
	req, _ := http.NewRequest("POST", e.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("notification: %d %s", res.StatusCode, b)
	}
	_, out, _ = e.mcpCall(tok, "tools/list", nil)
	if n := len(out["result"].(map[string]any)["tools"].([]any)); n != 6 {
		t.Fatalf("tools/list: %d tools", n)
	}
	if _, out, _ = e.mcpCall(tok, "nope", nil); out["error"].(map[string]any)["code"] != -32601.0 {
		t.Fatalf("unknown method: %v", out)
	}

	// Bob sees general but not alice's private channel.
	text, _ := e.tool(tok, "list_channels", nil)
	if !strings.Contains(text, "#general (id "+general.Id+")") || strings.Contains(text, "secret") {
		t.Fatalf("list_channels: %s", text)
	}
	if text, isErr := e.tool(tok, "read_messages", map[string]any{"channel": "secret"}); !isErr || strings.Contains(text, "cake") {
		t.Fatalf("read private: %v %s", isErr, text)
	}
	if text, isErr := e.tool(tok, "read_messages", map[string]any{"channel": secret.Id}); !isErr || strings.Contains(text, "cake") {
		t.Fatalf("read private by id: %v %s", isErr, text)
	}
	if text, _ := e.tool(tok, "search_messages", map[string]any{"query": "cake"}); text != "No messages match." {
		t.Fatalf("search leaked: %s", text)
	}
	text, _ = e.tool(tok, "read_messages", map[string]any{"channel": "#general"})
	if !strings.Contains(text, "@alice (id ") || !strings.Contains(text, ": hello @bob") {
		t.Fatalf("read_messages: %s", text)
	}

	// Bob posts, with a mention, and replies in a thread.
	text, isErr := e.tool(tok, "post_message", map[string]any{"channel": "general", "text": "hi @alice"})
	if isErr || !strings.HasPrefix(text, "Posted in #general") {
		t.Fatalf("post: %s", text)
	}
	list := must(alice.chat.ListMessages(ctx(), connect.NewRequest(&v1.ListMessagesRequest{ChannelId: general.Id}))).Messages
	last := list[len(list)-1]
	if last.AuthorId != bob.me.Id || last.Text != "hi <@"+alice.me.Id+">" {
		t.Fatalf("posted message: %+v", last)
	}
	if _, isErr := e.tool(tok, "post_message", map[string]any{"channel": "general", "text": "in thread", "thread": last.Id}); isErr {
		t.Fatal("thread reply failed")
	}
	text, _ = e.tool(tok, "read_messages", map[string]any{"channel": "general", "thread": last.Id})
	if !strings.Contains(text, "in thread") {
		t.Fatalf("thread: %s", text)
	}
	if text, _ := e.tool(tok, "search_messages", map[string]any{"query": "thread"}); !strings.Contains(text, "in #general, thread "+last.Id) {
		t.Fatalf("search: %s", text)
	}
	if text, isErr := e.tool(tok, "send_direct_message", map[string]any{"username": "@alice", "text": "psst"}); isErr || !strings.Contains(text, "DM with @alice") {
		t.Fatalf("dm: %s", text)
	}
	if text, _ := e.tool(tok, "list_members", map[string]any{"query": "ali"}); text != "@alice (Alice) owner, offline\n" {
		t.Fatalf("list_members: %q", text)
	}
	if text, isErr := e.tool(tok, "post_message", map[string]any{"channel": "general"}); !isErr || text != "text is required" {
		t.Fatalf("missing arg: %v %s", isErr, text)
	}

	// Signed in but not joined: a tool error that says to join.
	if text, isErr := e.tool(e.token("carol"), "list_channels", nil); !isErr || !strings.Contains(text, "Join it in the Sblurp app") {
		t.Fatalf("not joined: %v %s", isErr, text)
	}
}
