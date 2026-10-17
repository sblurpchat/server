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
| | `SBLURP_TRACK` | set at build (`stable`, `beta`, `nightly`) | Release track for the update check. |
| | `SBLURP_UPDATE_URL` | set at build | Release manifest (`releases.json`). Empty in local builds. |
| | `SBLURP_UPDATE_CHECK` | `on` | `off` stops the daily update check. |

Once a day the server does a plain GET of the release manifest. It sends no
data. When its track has a newer version, `GetMe` tells admins and the owner
in `update_available`. The server never updates itself; see
`deploy/README.md`.

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
  AVIF/HEIC the coded size, which can be a pixel larger for odd sizes).
  Images, audio and video are served inline; everything else as a
  download, with `nosniff` and a sandbox CSP. An upload not sent in a
  message within a day is deleted.
- **Roles and moderation**: owner > admin > moderator > member. Nobody
  acts on someone of equal or higher rank. `SetMemberRole`: admins and the
  owner, to MEMBER, MODERATOR or ADMIN below their own role (there is no
  ownership transfer). `KickMember` and `BanMember`: moderator or higher.
  A kicked or banned person, or one who calls `LeaveCommunity` (not the
  owner), gets their streams closed, leaves every channel, loses their custom
  roles and shows
  as `member_left`. Their member row stays (same id when they Join again,
  as a plain member). `BanMember` also blocks their `(iss, sub)` from
  `Join`. `ListBans` and `UnbanMember` (moderator or higher) show and lift
  bans; an unbanned person may Join again with the same member id. Bots are
  removed with `DeleteBot`, not kicked.
- **Invites**: a community is open (anyone with a login from a trusted
  issuer may `Join`) until an admin calls
  `UpdateServerSettings{invite_only: true}`. `GetServerInfo.invite_only`
  tells the join screen to ask for a code. Then `Join` needs
  `invite_code` (case-insensitive, spaces trimmed), except for the first
  person (the owner) and current members; someone who left or was kicked
  needs a new code. Admins `CreateInvite` (optional `expires_in_seconds`,
  up to a year, and `max_uses`), `ListInvites` (all not revoked, newest
  first, with `uses`) and `RevokeInvite`. A bad, expired, used-up or
  missing code is `permission_denied`. On an open community the code is
  ignored and not counted. Seeded communities are open.
- **Banner, description, header images** (1026, 1027). Admins upload an
  image (`POST /upload`), then pass its id as
  `UpdateServerSettings{banner_id}` or `UpdateChannel{header_image_id}`;
  `""` removes it. The upload must be the caller's own, unattached,
  PNG/JPEG/GIF/WebP/AVIF and at most 8 MB. `UpdateServerSettings{description}`
  stores Markdown (up to 2,000 characters; `""` falls back to
  `-description`). They show as `GetServerInfo.banner`/`description` and
  `Channel.header_image`, with signed URLs; a change emits `server_updated`
  (clients call `GetServerInfo` again) or `channel_updated`. Images in use
  are kept out of the orphan prune. Topics may span lines.
- **Channel modes and custom roles** (ticket 1011). `GetState` has
  `channel_mode`, `roles` (sorted by `position`) and, in `channels`, only
  the channels I am in: my sidebar. `UpdateServerSettings{channel_mode}`
  (admins; UNSPECIFIED leaves it) switches at any time and emits
  `channel_mode_changed`.
  - ROLES (the default): every member is in every text channel they can
    see. `JoinChannel` and `LeaveChannel` are `failed_precondition`.
  - OPT_IN: `BrowseChannels` lists every text channel I can see;
    `JoinChannel` and `LeaveChannel` add or drop one. Only joined channels
    are in `GetState`, have read states, get events and are searched by a
    `Search` without `channel_id`. A visible channel I have not joined can
    still be read with `ListMessages` or searched with its `channel_id`
    (preview). New members join the channels with `is_default`.
    Switching ROLES to OPT_IN keeps everyone in what they are in (which is
    everything they can see); OPT_IN to ROLES puts everyone in everything.
  - Roles: `Role{id, name, color, position}`. Admins `CreateRole`,
    `UpdateRole` (name, color `#rrggbb` or empty, position),
    `DeleteRole` (`failed_precondition` while it limits a channel) and
    `SetMemberRoles` (replaces the list; bots too). Events: `role_updated`
    (upsert), `role_deleted` (id), `member_updated` with `role_ids`.
    Roles never change permissions; the rank (`MemberRole`) does.
  - `SetChannelAccess{channel_id, role_ids, is_default}` (admins, text
    channels only). Empty `role_ids` means everyone may see it; otherwise
    members with one of those roles, plus admins and the owner. Private
    channels keep their member list.
  - When a change (roles, rank, access, mode, join) hides a channel from a
    member, they get `channel_deleted`; when it puts them in one, they get
    `channel_created`. Drop or add the channel on those. Members who still
    see it get `channel_updated`.
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
- `GET /invite/{code}` (and `/i/{code}`) redirects a browser to the web client's
  join screen: `{web}/#/join?url={base}&invite={code}`. Set the web client with
  `-web-url` / `SBLURP_WEB_URL` (default `https://app.sblurp.chat`).
- `GET /healthz` returns `ok`.

## Plugins

Drop JavaScript files in `<data>/plugins/` and restart the server. Each
`name.js` runs as a bot member called `name` (the file name must be a valid
username, and must not be a person's). `plugins/examples/dice.js` is a
working example: `/roll 2d6`, and only people with a verified email may
join.

A plugin defines any of these global functions:

| Hook | Called | Return |
|---|---|---|
| `onJoin(member)` | before someone new (or returning) joins. `member` has `iss`, `sub`, `username`, `display_name`, `email_verified`, `age_over_13`, `age_over_18` (from the login token; false when the issuer does not say), and `answer` if the plugin has a `joinQuestion`. | `{allow: false, reason}` turns them away with `permission_denied` and the reason (200 characters max). Anything else lets them in. |
| `onMessage(msg)` | after a message by a person in a channel the plugin's bot can see. `msg` has `id`, `text`, `thread_root_id`, `author {id, username, display_name}`, `channel {id, name}`. | a reply (below), or nothing |
| `onCommand(name, args, ctx)` | for a message `/name args` (name is 1 to 32 of a-z, 0-9, `_`, `-`). `ctx` has `message_id`, `thread_root_id`, `author`, `channel`. Every plugin sees every command; ignore the ones that are not yours. | a reply, or nothing |
| `joinQuestion` (a global string) | read at load (one line, 200 characters max). | Listed in `GetServerInfo.join_questions`; the join screen asks each one and sends `JoinRequest.answers` in the same order (trimmed, 1000 characters max each). The plugin checks `member.answer` in `onJoin`. |
| `every(minutes, fn)` | call at load time; `fn()` runs every `minutes` (whole minutes, at least 1). | a reply with a `channel` |

A reply is a string (posted where the message was, in its thread if it was
in one) or `{text, channel}` where `channel` is a channel name like
`"#general"` (posted there, outside threads). The bot can only post where
it can see. Bot messages never trigger hooks.

Limits: 32 MB of memory and 1 s per hook call (`Config.PluginMemory`,
`Config.PluginTimeout`). Hooks run one at a time in a queue (onJoin runs
inline in Join). A hook that throws, runs past its time or out of memory is
logged and skipped; a plugin whose runtime died is restarted from its
source, so top-level state resets. `console.log` goes to the server log.
There is no file, network, environment, `std`, `os` or timer access: QuickJS
runs under WASI with `/dev/null` as its root, so every file open fails,
and `std`/`os` are removed. Plugin state lives in memory only and is lost on
restart.

Why `fastschema/qjs`: it is QuickJS (full modern JS, small) compiled to
wasm and run on wazero, so it needs no CGO, keeps the single static binary,
and the memory limit and context cancel are enforced by the wasm sandbox.
The alternatives were goja (pure Go, but no memory limit and a slower,
older JS) and modernc's QuickJS port (not sandboxed by wasm).

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

Sblurp's own Fly setup is `server/fly.toml` plus `server/Dockerfile`,
described in `deploy/fly/README.md`. Litestream and restic back up to R2
when `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_ENDPOINT` and
`RESTIC_PASSWORD` are set; without them the image runs with no backups.

SQLite means one machine. Do not scale past 1.

## Docker

Released images are at `ghcr.io/<owner>/sblurp-server` (`:stable`, `:beta`,
`:nightly`). Compose files, auto-update and provenance checks are in
`deploy/README.md`. To build your own:

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
| `internal/server/plugins.go`, `plugins/examples/` | The plugin runtime and an example plugin. |
| `internal/server/roles.go` | Custom roles, channel modes, who sees which text channel. |
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
  members, or one member (`read_state`, `channel_created` on join). Replay
  and live delivery use the same rule. Text channels keep a member list
  (`channel_members`) too, so every channel event goes only to who is in
  it; `syncAccess` keeps those lists in step with roles, rank and mode
  inside the same write. Migration 005 deleted old events, so clients
  resync once.
- **Retention**: an event is pruned only when it is outside the newest
  10,000 *and* older than 7 days. Uploads never attached to a message are
  deleted after a day. Pruning runs at start and hourly.
- **Search** uses SQLite FTS5 (modernc's build includes it). User input is
  quoted word by word; the last word matches as a prefix.
- **Deleted messages** keep a tombstone row; text, reactions and
  attachments (including the files) are removed.
- **Deleted bots** keep their member row so old messages still have an
  author; their token stops working, they leave the member list, and their
  username becomes `name~id`, so the name is free again.
