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
- **Private channels**: the Members button lists only the people in the channel, with Add people (any member, as the server allows) and Remove (moderator and up, higher rank; hover to show). Your own row has Leave, with a confirm, because you can't get back in alone.
- **Invites**: Invite people (community menu) shows admins an Invite only switch, a form for a link (expiry, max uses) that copies itself when made, and the list of links with Copy and Revoke. Others see the address, or "ask an admin" when the community is invite only. A pasted `https://host/invite/CODE` fills in the server and the code; the consent screen shows an Invite code field only for invite-only communities. In fake mode letterpress.club is invite only with code INKSTAINED.
- **Admin tools**: admins get Create channel and Community settings in the community menu, a "+" on each sidebar section, and Edit #name in the channel header. The channel dialog edits name, topic, category, privacy and order. Community settings has Members (permission, kick, ban), Invites and Bots (create, new token shown once with Copy, delete).
- **Everyday**: the "+" next to Direct messages starts a DM or group message (up to 8 people). Your name in the corner opens Edit profile and status, per community. Message menu Copy link gives a `#/c/<host>/<channel>/<message>` link that jumps to the message. Mark all as read is in the community menu (Shift+Escape). Messages render `-` and `1.` lists.
- **Appearance** (Settings, saved per device): themes Match system, Light, Dark, Midnight, High contrast (7:1), Cherry cola and Mint; an accent picker (presets or any color, darkened or lightened until it reads at 4.5:1, 7:1 in high contrast); Cozy, Compact or IRC messages; Cozy or Compact sidebar; text size 12 to 20px; 12 or 24 hour clock; reduce motion. A live preview sits at the top. A theme is only token values on `[data-theme]` in `app.css`, and `logic.test.ts` checks every theme's contrast from that file. `node scripts/screens.mjs themes` shoots every theme in each density.
