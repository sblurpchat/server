# Sblurp web client

React + Vite + TypeScript. One window for every community you belong to.

```sh
pnpm dev          # http://localhost:5173  (?fake=1 for the built-in fake backend)
pnpm typecheck
pnpm test         # vitest: logic.ts and auth.ts
pnpm build
pnpm e2e          # fake-mode smoke test on 127.0.0.1:5198
pnpm screens      # light/dark x desktop/mobile PNGs into ../artifacts/web/
```

`?fake=1` runs a full in-browser backend (`src/fake.ts`, a Connect router
transport) with three joined communities and one to discover
(`letterpress.club`). It simulates typing, presence and new messages;
add `&quiet=1` to turn that off (the scripts do). `&signedout=1` shows sign-in.

## Files

| File | What |
|---|---|
| `src/logic.ts` | Pure functions: unread math, row grouping, sidebar sections, markdown tokens, mentions, member groups. All unit-tested. |
| `src/store.ts` | The one store (`useSyncExternalStore`), per-community Connect clients, subscriptions, reconnect, uploads. |
| `src/auth.ts` | PKCE sign-in against the auth server, one token per community audience, refresh under a Web Lock. |
| `src/App.tsx` | Shell, rail, sidebar, sign-in, join, dialogs, switcher, settings, profile popover. |
| `src/Chat.tsx` | Channel view, message list, rows, composer, right pane (thread, members, search). |
| `src/ui.tsx` | Icons, avatars, community icons, `Pop` (native popover), `Dialog` (native `<dialog>`), markdown renderer. |
| `src/fake.ts` | Fake mode. |
| `src/app.css` | All styles. Tokens on `:root`, dark mode via `prefers-color-scheme` or `data-theme`. |

## Dependencies beyond the allowed list

- `@types/react`, `@types/react-dom`: React ships no type declarations; `tsc` needs them. Types only, nothing in the bundle.

## Decisions

Things DESIGN.md and ARCHITECTURE.md left open, and what I picked.

- **Routing** is `#/c/<host>/<channel-id>` with `pushState`, so back/forward walk channel history. A community with no channel in the hash opens its last channel.
- **Message list** uses `flex-direction: column-reverse`. The browser keeps it pinned to the bottom and holds position when older pages prepend, with no scroll math. Thread panes top-align instead.
- **Read state**: a channel is marked read only when the list is scrolled to the bottom, the tab is visible and focused. Each seq is sent to the server once.
- **Unread rules** follow the server: top-level messages from others count as unread; thread replies do not, but a mention in a thread, and any DM message, counts as a mention.
- **Tab title**: `(3) #general | Sblurp` for mentions, `• #general | Sblurp` for plain unread.
- **Mobile** (≤767px): rail and sidebar become a drawer; the right pane goes full screen. The menu button carries a red dot when anything is unread, since the rail is hidden.
- **Collapsed sidebar sections** still show the selected channel and any channel with unread, like Slack.
- **Join consent**: display name and avatar default on, bio defaults off. The community gets only what is switched on.
- **Leave** calls LeaveCommunity, then drops the community locally. The owner gets the server's error ("The owner cannot leave.") in the dialog. **Remove** on an unreachable or removed community only drops it locally.
- **Create an account** goes to `/signup?next=<authorize URL>`, so the user lands back in the PKCE flow.
- **Tokens** refresh lazily, 60s before expiry. Refresh tokens are single-use, so every refresh runs under one Web Lock shared by all tabs and re-reads the refresh token inside the lock. Only `invalid_grant` signs you out; other token errors are shown and keep you signed in. The callback checks `iss` (RFC 9207).
- **Uploads** go to `POST {base}/upload` and are served by signed URLs (`?exp=&sig=`, one to two hours) relative to the community; drop files anywhere over the channel or thread pane (a dashed overlay shows while dragging). A broken image refetches its message (ListMessages around_id) for fresh URLs, at most once a minute.
- **Devnotes**: dev builds load `http://localhost:8090/devnotes.js` and remove the tag silently if it fails. The scripts block it so it does not appear in screenshots.
- **Contrast**: the badge red is `#D42A44` and dark-mode accent fill `#4A5EF2` so white text reaches 4.5:1.
- **Who reacted**: a dark tooltip on hover or focus ("You, Ana Ruiz and 2 others reacted with 👍"), and a list on right-click or press-and-hold (a bottom sheet on phones). The list opens on release, because a popover opened while the pointer is down is light-dismissed by the pointerup.
