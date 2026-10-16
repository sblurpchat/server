// Admin screens: create and edit channels, and community settings (members, invites, bots).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChannelKind, MemberKind, MemberRole, type Invite, type Member } from "./gen/sblurp/v1/sblurp_pb";
import { channelSlug, hostOf, inviteLink, inviteState, matchScore, modActions, reorderChannel, sidebarSections } from "./logic";
import {
  createBot,
  createChannel,
  createInvite,
  deleteBot,
  errorText,
  listBots,
  listInvites,
  revokeInvite,
  rotateBotToken,
  set,
  setInviteOnly,
  setRole,
  updateChannel,
  useApp,
} from "./store";
import { Avatar, Dialog, Icon } from "./ui";

/** The old rank. The UI calls it "Permission"; "Roles" are the custom tags from ticket 1011. */
export const PERMISSION: Record<number, string> = {
  [MemberRole.OWNER]: "Owner",
  [MemberRole.ADMIN]: "Admin",
  [MemberRole.MODERATOR]: "Moderator",
  [MemberRole.MEMBER]: "Member",
};

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="dialog-head">
      <h2>{title}</h2>
      {children}
      <button type="button" className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
        <Icon name="x" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Create or edit a channel
// ---------------------------------------------------------------------------

export function ChannelDialog({ id, category = "" }: { id?: string; category?: string }) {
  const c = useApp((s) => s.cs[s.url]);
  const ch = id ? c?.channels[id] : undefined;
  const [name, setName] = useState(ch?.name ?? "");
  const [topic, setTopic] = useState(ch?.topic ?? "");
  const [cat, setCat] = useState(ch?.category ?? category);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!c || (id && !ch)) return null;
  const slug = channelSlug(name);
  const sections = sidebarSections(c).filter((s) => !s.dm);
  const cats = [...new Set(sections.map((s) => s.title).filter((t) => t !== "Channels"))];
  const siblings = ch ? (sections.find((s) => s.title === (ch.category || "Channels"))?.channels ?? []) : [];
  const idx = ch ? siblings.findIndex((x) => x.id === ch.id) : -1;
  const fail = (x: unknown) => setErr(errorText(x, c.info?.name));
  const move = async (dir: -1 | 1) => {
    setErr("");
    try {
      for (const u of reorderChannel(siblings, ch!.id, dir)) await updateChannel(c.url, { channelId: u.id, position: u.position });
    } catch (x) {
      fail(x);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slug) return setErr("Use letters, numbers, - and _ only, up to 80 characters.");
    setBusy(true);
    setErr("");
    try {
      if (ch) await updateChannel(c.url, { channelId: ch.id, name: slug, topic: topic.trim(), category: cat.trim() });
      else await createChannel(c.url, { name: slug, kind: priv ? ChannelKind.PRIVATE : ChannelKind.TEXT, topic: topic.trim(), category: cat.trim() });
      set({ modal: null });
    } catch (x) {
      fail(x);
      setBusy(false);
    }
  };
  return (
    <Dialog label={ch ? `Edit #${ch.name}` : "Create a channel"} className="channel-dialog">
      <form onSubmit={submit} className="stack">
        <Head title={ch ? `Edit #${ch.name}` : "Create a channel"} />
        <label className="field">
          <b>Name</b>
          <span className="input-prefix">
            <Icon name={ch?.kind === ChannelKind.PRIVATE || priv ? "lock" : "hash"} size={16} />
            <input
              className="input"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="book-club"
              spellCheck={false}
              autoCapitalize="off"
              aria-describedby="chan-name-hint"
            />
          </span>
          <small id="chan-name-hint" className="muted">
            {!name.trim() ? "Lowercase, no spaces. Spaces become dashes." : slug ? (slug !== name ? `Saved as #${slug}` : " ") : "Use letters, numbers, - and _ only."}
          </small>
        </label>
        <label className="field">
          <b>Topic</b>
          <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What this channel is for" />
        </label>
        <label className="field">
          <b>Category</b>
          <input className="input" list="chan-cats" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="None" />
          <datalist id="chan-cats">
            {cats.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        {!ch && (
          <label className="toggle-row">
            <span>
              <b>Private</b>
              <small>Only people you add can see it.</small>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          </label>
        )}
        {ch && siblings.length > 1 && (
          <div className="toggle-row">
            <span>
              <b>Order</b>
              <small>
                {idx + 1} of {siblings.length} in {ch.category || "Channels"}
              </small>
            </span>
            <span className="row">
              <button type="button" className="btn small" disabled={idx <= 0} onClick={() => move(-1)}>
                Move up
              </button>
              <button type="button" className="btn small" disabled={idx >= siblings.length - 1} onClick={() => move(1)}>
                Move down
              </button>
            </span>
          </div>
        )}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="row-end">
          <button type="button" className="btn ghost" onClick={() => set({ modal: null })}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {ch ? "Save changes" : "Create channel"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Community settings
// ---------------------------------------------------------------------------

const TABS = [
  ["members", "Members"],
  ["invites", "Invites"],
  ["bots", "Bots"],
] as const;
export type SettingsTab = (typeof TABS)[number][0];

export function CommunitySettings({ tab = "members" }: { tab?: SettingsTab }) {
  const c = useApp((s) => s.cs[s.url]);
  if (!c?.me) return null;
  const name = c.info?.name ?? hostOf(c.url);
  const go = (t: SettingsTab) => set({ modal: { t: "community", tab: t } });
  return (
    <Dialog label={`${name} settings`} className="community-settings">
      <Head title={`${name} settings`} />
      <div className="cs-body">
        <nav role="tablist" aria-label="Sections" className="cs-tabs">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              role="tab"
              id={`cs-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="cs-panel"
              tabIndex={tab === t ? 0 : -1}
              onClick={() => go(t)}
              onKeyDown={(e) => {
                const i = TABS.findIndex(([x]) => x === t);
                const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const next = TABS[(i + d + TABS.length) % TABS.length][0];
                go(next);
                requestAnimationFrame(() => document.getElementById(`cs-tab-${next}`)?.focus());
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div role="tabpanel" id="cs-panel" aria-labelledby={`cs-tab-${tab}`} className="cs-panel">
          {tab === "members" && <MembersTab url={c.url} />}
          {tab === "invites" && <Invites url={c.url} inviteOnly={!!c.info?.inviteOnly} />}
          {tab === "bots" && <BotsTab url={c.url} />}
        </div>
      </div>
    </Dialog>
  );
}

function MembersTab({ url }: { url: string }) {
  const c = useApp((s) => s.cs[url]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const people = Object.values(c.members)
    .filter((m) => m.kind === MemberKind.HUMAN)
    .map((m) => [m, q ? matchScore(q, `${m.displayName} ${m.username}`) : 1] as const)
    .filter(([, s]) => s > 0)
    .sort(([a], [b]) => b.role - a.role || (a.displayName || a.username).localeCompare(b.displayName || b.username))
    .map(([m]) => m);
  return (
    <div className="stack">
      <input className="input" type="search" placeholder="Search members" aria-label="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <ul className="admin-list" aria-label="Members">
        {people.map((m) => (
          <MemberAdminRow key={m.id} url={url} me={c.me} m={m} onError={setErr} />
        ))}
      </ul>
      {!people.length && <p className="muted small">Nobody matches “{q}”.</p>}
    </div>
  );
}

function MemberAdminRow({ url, me, m, onError }: { url: string; me?: Member; m: Member; onError: (e: string) => void }) {
  const mod = modActions(me, m);
  const name = m.displayName || m.username;
  return (
    <li>
      <Avatar m={m} size={32} presence />
      <span className="truncate">
        <b>{name}</b>
        <small className="muted">@{m.username}</small>
      </span>
      {mod.roles.length ? (
        <select
          className="input small"
          aria-label={`Permission for ${name}`}
          value={m.role}
          onChange={(e) => (onError(""), setRole(url, m.id, Number(e.target.value)).catch((x) => onError(errorText(x))))}
        >
          {mod.roles.map((r) => (
            <option key={r} value={r}>
              {PERMISSION[r]}
            </option>
          ))}
        </select>
      ) : (
        <small className="muted perm">{m.id === me?.id ? `${PERMISSION[m.role]} (you)` : PERMISSION[m.role]}</small>
      )}
      {mod.remove && (
        <span className="row">
          {[false, true].map((ban) => (
            <button
              key={String(ban)}
              className="btn danger-ghost small"
              aria-label={`${ban ? "Ban" : "Kick"} ${name}`}
              onClick={() => set({ modal: { t: "remove", url, memberId: m.id, ban } })}
            >
              {ban ? "Ban" : "Kick"}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}

function TokenOnce({ who, token, onDone }: { who: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="token-once" role="status">
      <b>Token for {who}</b>
      <p className="small">Copy it now. Sblurp shows it only once. Anyone with it can post as {who}.</p>
      <div className="copy-row">
        <input className="input" readOnly value={token} aria-label={`Token for ${who}`} onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={() => navigator.clipboard.writeText(token).then(() => setCopied(true))}>
          <Icon name={copied ? "check" : "copy"} size={16} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button className="btn ghost small" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function BotsTab({ url }: { url: string }) {
  const [bots, setBots] = useState<Member[] | null>(null);
  const [token, setToken] = useState<{ who: string; token: string } | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", bio: "" });
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const fail = (e: unknown) => setErr(errorText(e));
  const load = () => listBots(url).then(setBots, fail);
  useEffect(() => void load(), [url]);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await createBot(url, { username: form.username.trim(), displayName: form.displayName.trim(), bio: form.bio.trim() });
      setToken({ who: r.bot?.displayName || form.username, token: r.token });
      setForm({ username: "", displayName: "", bio: "" });
      await load();
    } catch (x) {
      fail(x);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">
        A bot posts with a token, using the same API as this app. Run one with the example in the server README.
      </p>
      {token && <TokenOnce {...token} onDone={() => setToken(null)} />}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {bots && !bots.length && <p className="muted small">No bots yet.</p>}
      {!!bots?.length && (
        <ul className="admin-list" aria-label="Bots">
          {bots.map((b) => {
            const name = b.displayName || b.username;
            return (
              <li key={b.id}>
                <Avatar m={b} size={32} />
                <span className="truncate">
                  <b>{name}</b>
                  <small className="muted">@{b.username}</small>
                </span>
                {confirm === b.id ? (
                  <span className="row">
                    <button className="btn ghost small" onClick={() => setConfirm("")}>
                      Keep
                    </button>
                    <button
                      className="btn danger small"
                      onClick={() =>
                        deleteBot(url, b.id).then(
                          () => (setConfirm(""), load()),
                          fail,
                        )
                      }
                    >
                      Delete {name}
                    </button>
                  </span>
                ) : (
                  <span className="row">
                    <button
                      className="btn small"
                      aria-label={`New token for ${name}`}
                      onClick={() => rotateBotToken(url, b.id).then((t) => setToken({ who: name, token: t }), fail)}
                    >
                      New token
                    </button>
                    <button className="btn danger-ghost small" aria-label={`Delete ${name}`} onClick={() => setConfirm(b.id)}>
                      Delete
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="bot-new stack" onSubmit={make}>
        <h3>Add a bot</h3>
        <div className="row-fields">
          <label className="field">
            <b>Username</b>
            <input
              className="input"
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="kiln-bot"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field">
            <b>Display name</b>
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Kiln Bot" />
          </label>
        </div>
        <label className="field">
          <b>About</b>
          <input className="input" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="What it does" />
        </label>
        <div className="row-end">
          <button className="btn primary" disabled={!form.username.trim()}>
            Create bot
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invites (also shown in the Invite people dialog)
// ---------------------------------------------------------------------------

const EXPIRES = [
  ["Never", 0],
  ["1 day", 86400],
  ["7 days", 7 * 86400],
  ["30 days", 30 * 86400],
] as const;
const MAX_USES = [0, 1, 5, 10, 25];

/** Admin view: invite-only switch, a form to make a link, and the live links. */
export function Invites({ url, inviteOnly }: { url: string; inviteOnly: boolean }) {
  const [list, setList] = useState<Invite[] | null>(null);
  const [expires, setExpires] = useState(7 * 86400);
  const [maxUses, setMaxUses] = useState(0);
  const [copied, setCopied] = useState("");
  const [err, setErr] = useState("");
  const fail = (e: unknown) => setErr(errorText(e));
  const load = () => listInvites(url).then(setList, fail);
  useEffect(() => void load(), [url]);
  const copy = (code: string) => navigator.clipboard.writeText(inviteLink(url, code)).then(() => setCopied(code));
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await createInvite(url, expires, maxUses);
      await load();
      if (r.invite) copy(r.invite.code).catch(() => {});
    } catch (x) {
      fail(x);
    }
  };
  const now = Date.now();
  return (
    <div className="invites">
      <label className="invite-only">
        <span>
          <b>Invite only</b>
          <small className="muted">{inviteOnly ? "People need an invite link to join." : "Anyone with the address can join."}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={inviteOnly}
          onChange={(e) => setInviteOnly(url, e.target.checked).catch(fail)}
        />
      </label>
      <form className="invite-new" onSubmit={make}>
        <label>
          Expires
          <select className="input" value={expires} onChange={(e) => setExpires(+e.target.value)}>
            {EXPIRES.map(([t, v]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Uses
          <select className="input" value={maxUses} onChange={(e) => setMaxUses(+e.target.value)}>
            {MAX_USES.map((n) => (
              <option key={n} value={n}>
                {n ? n : "No limit"}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary">Create link</button>
      </form>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {list && !list.length && <p className="muted small">No invite links yet.</p>}
      {!!list?.length && (
        <ul className="invite-list" aria-label="Invite links">
          {list.map((i) => {
            const st = inviteState(i, now);
            return (
              <li key={i.code} className={st.live ? "" : "dead"}>
                <span className="truncate">
                  <code>{i.code}</code>
                  <small className="muted">{st.text}</small>
                </span>
                {st.live && (
                  <button className="btn" onClick={() => copy(i.code)} aria-label={`Copy invite link ${i.code}`}>
                    <Icon name={copied === i.code ? "check" : "copy"} size={16} /> {copied === i.code ? "Copied" : "Copy"}
                  </button>
                )}
                <button
                  className="btn ghost"
                  onClick={() => revokeInvite(url, i.code).then(load, fail)}
                  aria-label={`Revoke invite ${i.code}`}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
