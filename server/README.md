# Sblurp community server

One community, one binary, one SQLite file. People log in with sblurp.chat
(or any issuer you trust). Bots are members with a token. License: AGPL-3.0
(see `LICENSE`).

## Run

```sh
go run ./cmd/sblurp-server -addr :8082 -data ../.data/community \
  -name "Sblurp Community" -base-url http://localhost:8082 \
  -trusted-issuer http://localhost:8081 -seed community
```

`make dev` at the repo root runs this, plus a second community
(`-seed owls`, "Night Owls") on :8083.

Check it:

```sh
curl -H 'Content-Type: application/json' -d '{}' \
  http://localhost:8082/sblurp.v1.ServerService/GetServerInfo
```

### Flags

Every flag can also come from an environment variable.

| Flag | Env | Default | What |
|---|---|---|---|
| `-addr` | `SBLURP_ADDR` | `:8082` | Listen address. HTTP/1.1 and cleartext HTTP/2 (h2c). |
| `-data` | `SBLURP_DATA` | `data` | Data directory: `sblurp.db`, `files/`, `file-key`, `bot-token.txt`. |
| `-name` | `SBLURP_NAME` | `Sblurp Community` | Community name. |
| `-description` | `SBLURP_DESCRIPTION` | seed's text | One line for the join screen. |
| `-icon-url` | `SBLURP_ICON_URL` | | Rail icon. |
| `-accent` | `SBLURP_ACCENT` | seed's color | `#rrggbb` for the rail icon. |
| `-base-url` | `SBLURP_BASE_URL` | required | Public URL. Also the JWT audience. |
| `-trusted-issuer` | `SBLURP_TRUSTED_ISSUERS` (comma separated) | `https://sblurp.chat` | Login issuers to accept. Repeat the flag for more. |
| `-seed` | `SBLURP_SEED` | | `community` or `owls`. Fills an empty database with demo data. Ignored when the database has members. |
| `-bot-rate` | `SBLURP_BOT_RATE` | `0` (no limit) | SendMessage per second for bots. |
| `-bot-burst` | `SBLURP_BOT_BURST` | `20` | Burst for bots. |

People are limited to 5 messages per second, burst 10.

## Run the example bot

The seed creates one bot ("Slurpy" or "Hoot") and writes its token to
`<data>/bot-token.txt` (mode 0600). In a second terminal, with `make dev`
running:

```sh
cd server
go run ./cmd/example-bot -url http://localhost:8082 -token-file ../.data/community/bot-token.txt
# or: SBLURP_BOT_TOKEN=sbb_... go run ./cmd/example-bot -url http://localhost:8082
```

Then in the web client, write `@Slurpy roll d20`, `@Slurpy roll 2d6`,
`@Slurpy time` or `@Slurpy help`. It replies in the same channel or thread.

For any other bot: an admin calls `BotService.CreateBot`, keeps the token
(shown once), and runs the bot with it. A bot uses the same API as the web
client. There is no separate apps system. The bot is ~150 lines in
`cmd/example-bot/main.go`; copy it.

## API notes for clients

- Connect RPC, `proto/sblurp/v1/sblurp.proto`. Every call except
  `GetServerInfo` needs `Authorization: Bearer <token>`. A logged-in person
  who has not joined may only call `GetServerInfo` and `Join`
  (others return `permission_denied`).
- **Subscribe** sends a `heartbeat` event at once (so the response starts
  without delay) and then every 25 s. Pass the last applied `seq` as
  `after_seq`. If the server cannot replay that far (more than 10,000 events
  and 7 days old, or a seq from the future), the first non-heartbeat event
  is `resync`: call `GetState` and continue from its `seq`. The stream stays
  open after a resync. A subscriber that falls more than 512 events behind
  is dropped with `resource_exhausted`; reconnect with the last seq.
  Typing, presence and heartbeat events have `seq = 0`.
- **Unread counts** start at the member's join, so a new member sees no old
  history as unread. `unread_count` counts top-level messages (not thread
  replies) by others. `mention_count` counts `<@member_id>` in any message
  (thread replies too) and every message in a DM. `MarkRead` with `seq = 0`
  marks everything read. To decide if a message is new, compare its
  `created_seq` (never changes) with `last_read_seq`, not `seq` (which an
  edit, reaction or reply bumps). It emits a `read_state` event (with a seq) to all of
  that member's subscriptions.
- **ListMessages** lists top-level messages, or a thread's replies when
  `thread_root_id` is set (the root is not included). A deleted message is
  left out, unless it is a thread root with replies; then it shows as
  `deleted: true` with empty text. Paging: `before_id` gives older
  messages, `after_id` newer ones, and `around_id` the message itself with
  about `limit/2` older ones and the rest newer (to jump to a search hit; for
  a thread reply also pass its `thread_root_id`). Set at most one. Results
  are always oldest first. `has_more` means older messages exist,
  `has_more_after` means newer ones exist.
- **Upload**: `POST /upload`, `multipart/form-data` with one part named
  `file`, same Bearer token, 25 MB max. The response is the `Attachment`
  message as protojson, so parse it with `fromJson`. Note that `size` is a
  string in protojson (int64):

  ```json
  {"id":"01a1...","name":"cat.png","contentType":"image/png","size":"14211",
   "url":"/files/01a1.../cat.png?exp=1792000800&sig=...","width":640,"height":480}
  ```

  Then send the id in `SendMessage.attachment_ids` (max 10, only your own
  unused uploads). Errors are `{"error": "..."}` with status 400, 401, 403
  or 413.
- **Files**: `GET /files/{id}/{name}?exp=...&sig=...`, relative to the
  server base URL. Use `Attachment.url` exactly as the server returns it.
  The server signs it (HMAC-SHA256 over id and exp, with a key in
  `<data>/file-key`) only in responses and events for members who may see
  the file, and for the uploader of an unattached upload. It works in
  `<img src>` without a header. A URL is valid for one to two hours (exp is
  rounded up to the hour, so it stays the same for an hour and the browser
  can cache it). A missing, wrong or expired signature returns 403
  `{"error": ...}`; the client gets fresh URLs by listing the messages
  again. Removing a member does not revoke URLs they already hold. The
  content type is sniffed by the server (AVIF and HEIC too). `width` and
  `height` are set for PNG, JPEG, GIF, WebP, BMP, AVIF and HEIC (for
  AVIF/HEIC the coded size, which can be a pixel larger for odd sizes). Images, audio and video are served
  inline; everything else as a download, with `nosniff` and a sandbox CSP.
- **Roles and moderation**: owner > admin > moderator > member. Nobody
  acts on someone of equal or higher rank. `SetMemberRole`: admins and the
  owner, to MEMBER, MODERATOR or ADMIN below their own role (there is no
  ownership transfer). `KickMember` and `BanMember`: moderator or higher.
  A kicked or banned person, or one who calls `LeaveCommunity` (not the
  owner), gets their streams closed, leaves every private channel and shows
  as `member_left`. Their member row stays (same id when they Join again,
  as a plain member). `BanMember` also blocks their `(iss, sub)` from
  `Join`. Bots are removed with `DeleteBot`, not kicked.
- **Private channel members**: any member of a private channel may
  `AddChannelMembers`; added members get `channel_updated` for a channel
  they did not have yet (upsert it), and its old messages are not unread.
  `RemoveChannelMember` with your own id leaves; removing someone else
  needs a higher rank (moderator or higher). The removed member gets
  `channel_deleted` with the channel id.
- Errors use Connect codes with plain messages: `invalid_argument`,
  `permission_denied`, `not_found` (also for channels you may not see),
  `already_exists`, `resource_exhausted`, `unauthenticated`.
- Channel names are normalized: `"Book Club"` becomes `book-club`.
- `GET /healthz` returns `ok`.

## Deploy on a $5 VPS with Caddy

The server is one static binary and one directory. Caddy adds TLS.

```sh
# on your machine
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOWORK=off go build -trimpath -o sblurp-server ./cmd/sblurp-server
scp sblurp-server you@vps:/usr/local/bin/
```

On the VPS, `/etc/systemd/system/sblurp.service`:

```ini
[Unit]
Description=Sblurp community server
After=network-online.target

[Service]
User=sblurp
Environment=SBLURP_ADDR=127.0.0.1:8080
Environment=SBLURP_DATA=/var/lib/sblurp
Environment=SBLURP_NAME=My Community
Environment=SBLURP_BASE_URL=https://chat.example.com
Environment=SBLURP_TRUSTED_ISSUERS=https://sblurp.chat
ExecStart=/usr/local/bin/sblurp-server
StateDirectory=sblurp
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/caddy/Caddyfile`:

```
chat.example.com {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1   # stream Subscribe events at once
	}
}
```

```sh
sudo useradd --system sblurp
sudo systemctl enable --now sblurp
sudo systemctl reload caddy
```

The first person to join becomes the owner. Back up `/var/lib/sblurp`
(`sqlite3 sblurp.db ".backup backup.db"` and the `files/` directory).

## Deploy on Fly

```sh
cd server
fly launch --copy-config --no-deploy   # edit app name and SBLURP_BASE_URL in fly.toml first
fly volumes create sblurp_data --size 1
fly deploy
```

SQLite means one machine. Do not scale past 1.

## Docker

```sh
docker build -t sblurp-server .
docker run -p 8080:8080 -v sblurp:/data \
  -e SBLURP_BASE_URL=http://localhost:8080 sblurp-server
```

## Tests

```sh
go vet ./... && go test -race -count=1 ./...
```

`internal/server/server_test.go` starts the real HTTP server, a fake issuer
with a JWKS, and real Connect clients, with a fake clock.

## Layout and decisions

| Path | What |
|---|---|
| `cmd/sblurp-server` | Flags, HTTP server, graceful shutdown. |
| `cmd/example-bot` | The example bot. |
| `internal/server/db.go` | SQLite (WAL, one writer, reader pool), embedded migrations, events, UUIDv7. |
| `internal/server/migrations/` | `NNN_name.sql`, applied in order, tracked by `PRAGMA user_version`. |
| `internal/server/auth.go` | EdDSA JWT check, JWKS cache, bot tokens, the auth interceptor. |
| `internal/server/hub.go` | Live fan-out, presence. |
| `internal/server/rpc.go` | Every RPC. Validation helpers are pure functions. |
| `internal/server/files.go` | Upload and file serving. |
| `internal/server/seed.go`, `internal/seed/` | Demo data. |

- **JWT check by hand.** About 80 lines of standard library (`crypto/ed25519`,
  `encoding/json`). It accepts only `alg: EdDSA`, checks the issuer against
  the trusted list *before* fetching any keys (so a token cannot make the
  server fetch a URL of its choice), then the signature, `aud`, `exp`, `iat`
  and `nbf` with 60 s skew. JWKS are cached for an hour; an unknown `kid`
  triggers a refetch at most every 30 s per issuer.
- **Every write goes through `writeTx`** (one mutex, one connection). Events
  get their seq inside the transaction and are published to the hub after
  commit while the lock is still held, so live order equals seq order.
- **Event visibility** is stored with the event: public, one channel's
  members (private channels and DMs), or one member (`read_state`). Replay
  and live delivery use the same rule.
- **Retention**: an event is pruned only when it is outside the newest
  10,000 *and* older than 7 days. Pruning runs at start and hourly.
- **Search** uses SQLite FTS5 (modernc's build includes it). User input is
  quoted word by word; the last word matches as a prefix.
- **Deleted messages** keep a tombstone row; text, reactions and
  attachments (including the files) are removed.
- **Deleted bots** keep their member row so old messages still have an
  author; their token stops working, they leave the member list, and their
  username becomes `name~id`, so the name is free again.
