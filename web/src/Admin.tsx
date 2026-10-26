// Admin screens: create and edit channels, and community settings (members, invites, bots).
import { AUTH_URL } from "./auth";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChannelKind, ChannelMode, MemberKind, MemberRole, type Ban, type Channel, type GetMeResponse, type Invite, type Member, type Message, type Plugin, type Report, type Role } from "./gen/sblurp/v1/sblurp_pb";
import { BANNER_TYPES, bannerFileError, banDetail, channelSlug, count, hostOf, memberRoles, inviteState, shareInviteLink, matchScore, modActions, pluginFormError, pluginNameFromFile, pluginStatus, reportDetail, reportPlace, tokenBots, reorderChannel, sidebarSections, squareCrop, unsavedBlock } from "./logic";
import {
  absUrl,
  setCommunityProfile,
  upload,
  browseChannels,
  createBot,
  createChannel,
  createRole,
  deleteRole,
  setChannelAccess,
  setChannelMode,
  setMemberRoles,
  updateRole,
  createInvite,
  deleteBot,
  deletePlugin,
  errorText,
  installPlugin,
  listPlugins,
  setPluginEnabled,
  getMe,
  jumpTo,
  listBans,
  listBots,
  listReports,
  reportMessage,
  resolveReport,
  listInvites,
  revokeInvite,
  rotateBotToken,
  set,
  setInviteOnly,
  setRetention,
  setRole,
  unbanMember,
  updateChannel,
  useApp,
} from "./store";
import { EmojiTab } from "./CustomEmoji";
import { AUTOFOCUS, Avatar, CopyButton, Dialog, Icon, Skeleton } from "./ui";

/** The old rank. The UI calls it "Permission"; "Roles" are the custom tags from ticket 1011. */
export const PERMISSION: Record<number, string> = {
  [MemberRole.OWNER]: "Owner",
  [MemberRole.ADMIN]: "Admin",
  [MemberRole.MODERATOR]: "Moderator",
  [MemberRole.MEMBER]: "Member",
};

function Head({ title, children, close = () => set({ modal: null }) }: { title: string; children?: ReactNode; close?: () => void }) {
  return (
    <header className="dialog-head">
      <h2>{title}</h2>
      {children}
      <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
        <Icon name="x" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Create or edit a channel
// ---------------------------------------------------------------------------

export function ChannelDialog({ id, category = "", name: initial = "", focusTopic }: { id?: string; category?: string; name?: string; focusTopic?: boolean }) {
  const c = useApp((s) => s.cs[s.url]);
  const ch = id ? c?.channels[id] : undefined;
  const [name, setName] = useState(ch?.name ?? initial);
  const [topic, setTopic] = useState(ch?.topic ?? "");
  const [cat, setCat] = useState(ch?.category ?? category);
  const [priv, setPriv] = useState(false);
  const [post, setPost] = useState(ch?.postRoleIds ?? []);
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
      if (ch) await updateChannel(c.url, { channelId: ch.id, name: slug, topic: topic.trim(), category: cat.trim(), postRoles: { roleIds: post } });
      else await createChannel(c.url, { name: slug, kind: priv ? ChannelKind.PRIVATE : ChannelKind.TEXT, topic: topic.trim(), category: cat.trim() }, post);
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
              autoFocus={AUTOFOCUS && !focusTopic}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="book-club"
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
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
          <textarea className="input textarea" rows={3} maxLength={500} autoFocus={AUTOFOCUS && focusTopic} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What this channel is for" />
          <small className="muted">Markdown works. The header shows two lines; people can open the rest.</small>
        </label>
        {ch && (
          <ImageField
            label="Header image"
            hint="Shown faintly behind the channel name and topic. PNG, JPEG, GIF, WebP or AVIF, up to 8 MB."
            src={absUrl(c.url, ch.headerImage?.url ?? "")}
            onChange={(id) => updateChannel(c.url, { channelId: ch.id, headerImageId: id })}
          />
        )}
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
        <fieldset className="role-checks post-roles">
          <legend>
            <b>Who can post</b>
          </legend>
          <label>
            <input type="radio" name="post" checked={!post.length} onChange={() => setPost([])} />
            Everyone
          </label>
          <label>
            <input type="radio" name="post" checked={!!post.length} onChange={() => setPost(["admin", "moderator"])} />
            Only these roles
          </label>
          <div className="post-pick" data-open={!!post.length} inert={!post.length}>
            <div>
              <label>
                <input type="checkbox" checked disabled />
                Admins and the owner
              </label>
              {[{ id: "moderator", name: "Moderators", color: "" }, ...c.roles].map((r) => (
                <label key={r.id}>
                  <input type="checkbox" checked={post.includes(r.id)} onChange={(e) => setPost(e.target.checked ? [...post, r.id] : post.filter((x) => x !== r.id))} />
                  {r.id !== "moderator" && <span className="role-dot" style={{ ["--role" as string]: r.color || "var(--graphite)" }} />}
                  {r.name}
                </label>
              ))}
            </div>
          </div>
          <small className="muted">Owners, admins and bots can always post. Everyone can react and reply in threads.</small>
        </fieldset>
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

/** A square, at most 512 px copy of an image for the community icon (1044). GIFs stay as they are to keep animation. */
async function squareIcon(file: File): Promise<File> {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const { sx, sy, side, out } = squareCrop(bmp.width, bmp.height, 512);
    if (out === bmp.width && out === bmp.height) return file;
    const cv = document.createElement("canvas");
    cv.width = cv.height = out;
    cv.getContext("2d")!.drawImage(bmp, sx, sy, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/webp", 0.9));
    return blob ? new File([blob], `${file.name.replace(/\.\w+$/, "")}.${blob.type.split("/")[1]}`, { type: blob.type }) : file;
  } catch {
    return file; // the server checks it anyway
  }
}

/** Uploads a banner or header image and applies it at once; "" removes it. Checked like the server checks it. */
function ImageField({
  label,
  hint,
  src,
  square,
  onChange,
}: {
  label: string;
  hint: string;
  src: string;
  square?: boolean;
  onChange: (id: string) => Promise<void>;
}) {
  const c = useApp((s) => s.cs[s.url]);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState("");
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await f();
    } catch (x) {
      setErr(errorText(x, c?.info?.name));
    }
    setBusy(false);
  };
  const pick = (file?: File) => {
    if (!file || !c) return;
    // Icons are shrunk first, so only their type is checked before that.
    const bad = bannerFileError(square ? { type: file.type, size: 0 } : file);
    if (bad) return setErr(bad);
    void run(async () => {
      const f = square ? await squareIcon(file) : file;
      const big = bannerFileError(f);
      if (big) return setErr(big);
      await onChange((await upload(c.url, f)).id);
    });
  };
  return (
    <div
      className="field image-field dropzone"
      data-over={over || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files[0]);
      }}
    >
      <b>{label}</b>
      {src && <img className={square ? "image-preview square" : "image-preview"} src={src} alt={`Current ${label.toLowerCase()}`} />}
      <small className="muted">{hint}</small>
      <span className="row">
        <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="image" size={16} /> {busy ? "Saving..." : src ? "Replace" : "Upload image"}
        </button>
        {src && (
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => run(() => onChange(""))}>
            Remove
          </button>
        )}
      </span>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={`${label} file`}
        accept={BANNER_TYPES.join(",")}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** Banner and Markdown description, shown at the top of everyone's sidebar (1026). */
function AboutTab({ url, focusDesc }: { url: string; focusDesc?: boolean }) {
  const c = useApp((s) => s.cs[url]);
  const saved = c?.info?.description ?? "";
  const [desc, setDesc] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const dirty = desc.trim() !== saved;
  useDirty("about-form", dirty);
  if (!c) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await setCommunityProfile(url, { description: desc.trim() });
    } catch (x) {
      setErr(errorText(x, c.info?.name));
    }
    setBusy(false);
  };
  return (
    <div className="stack">
      <ImageField
        label="Banner"
        hint="Shown behind the community name in everyone's sidebar. Wide images work best. PNG, JPEG, GIF, WebP or AVIF, up to 8 MB."
        src={absUrl(url, c.info?.bannerUrl ?? "")}
        onChange={(id) => setCommunityProfile(url, { bannerId: id })}
      />
      <ImageField
        label="Icon"
        hint="Shown in everyone's community rail, cropped to a square. Big images are shrunk before upload. Drop an image here or pick one."
        src={absUrl(url, c.info?.iconUrl ?? "")}
        square
        onChange={(id) => setCommunityProfile(url, { iconId: id })}
      />
      <form id="about-form" className="field" onSubmit={submit} onReset={(e) => (e.preventDefault(), setDesc(saved))} data-dirty={dirty || undefined}>
        <label htmlFor="about-desc">
          <b>Description</b>
        </label>
        <textarea id="about-desc" className="input textarea" autoFocus={AUTOFOCUS && focusDesc} rows={5} maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} />
        <small className="muted">Markdown works: **bold**, _italic_, `code` and [links](https://example.com). Shown under the name in everyone's sidebar.</small>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="row-end">
          <button className="btn primary" disabled={busy || !dirty}>
            Save description
          </button>
        </div>
      </form>
      <Retention url={url} />
      <ServerVersion url={url} />
    </div>
  );
}

const KEEP = [7, 30, 90, 365];

/** Message retention (1072). Nothing changes until Save, because a shorter time deletes messages for everyone. */
function Retention({ url }: { url: string }) {
  const saved = useApp((s) => s.cs[url]?.info?.retentionDays ?? 0);
  const [pick, setPick] = useState<number | "custom">(saved && !KEEP.includes(saved) ? "custom" : saved);
  const [custom, setCustom] = useState(saved || 180);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const days = pick === "custom" ? custom : pick;
  const valid = Number.isInteger(days) && days >= 0 && days <= 3650;
  const shorter = days > 0 && (saved === 0 || days < saved);
  useDirty("retention-form", days !== saved);
  const reset = (e: FormEvent) => {
    e.preventDefault();
    setPick(saved && !KEEP.includes(saved) ? "custom" : saved);
    setCustom(saved || 180);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await setRetention(url, days);
    } catch (x) {
      setErr(errorText(x));
    }
    setBusy(false);
  };
  return (
    <form id="retention-form" className="field" onSubmit={save} onReset={reset} data-dirty={days !== saved || undefined}>
      <label htmlFor="retention">
        <b>Message history</b>
      </label>
      <select id="retention" className="input" value={pick} onChange={(e) => setPick(e.target.value === "custom" ? "custom" : +e.target.value)}>
        <option value={0}>Keep forever</option>
        {KEEP.map((d) => (
          <option key={d} value={d}>
            Delete after {d === 365 ? "1 year" : `${d} days`}
          </option>
        ))}
        <option value="custom">Delete after a number of days</option>
      </select>
      {pick === "custom" && (
        <label className="row" style={{ animation: "fade-in 150ms ease-out" }}>
          <input type="number" className="input" min={1} max={3650} required value={custom} onChange={(e) => setCustom(e.target.valueAsNumber)} />
          days
        </label>
      )}
      <small className="muted">
        {saved ? `Messages, thread replies and files older than ${saved} days are deleted for everyone.` : "Messages stay until someone deletes them."}
      </small>
      {shorter && days !== saved && (
        <p className="update-note" style={{ animation: "fade-in 150ms ease-out" }}>
          <Icon name="info" size={16} />
          <span>Older messages will be deleted for everyone within the hour. This cannot be undone.</span>
        </p>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn primary" disabled={busy || !valid || days === saved}>
          Save history setting
        </button>
      </div>
    </form>
  );
}

/** Version and update track, for admins and the owner (1038). The server leaves them empty for others. */
function ServerVersion({ url }: { url: string }) {
  const [me, setMe] = useState<GetMeResponse>();
  useEffect(() => {
    getMe(url).then(setMe, () => {});
  }, [url]);
  if (!me?.serverVersion) return null;
  return (
    <section className="field server-version">
      <b>Server</b>
      <p className="muted">
        Version {me.serverVersion}
        {me.serverTrack && ` on the ${me.serverTrack} track`}.{" "}
        <a href="https://sblurp.chat/docs/updates#tracks" target="_blank" rel="noreferrer">
          Change track <Icon name="external" size={14} />
        </a>
      </p>
      {me.updateAvailable && (
        <p className="update-note">
          <Icon name="info" size={16} />
          <span>
            Update available: v{me.updateAvailable}.{" "}
            <a href="https://sblurp.chat/docs/self-host" target="_blank" rel="noreferrer">
              How to update <Icon name="external" size={14} />
            </a>
          </span>
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Community settings
// ---------------------------------------------------------------------------

const TABS = [
  ["about", "About"],
  ["members", "Members"],
  ["roles", "Roles"],
  ["channels", "Channels"],
  ["invites", "Invites"],
  ["bans", "Bans"],
  ["bots", "Bots"],
  ["emoji", "Emoji"],
] as const;
export type SettingsTab = (typeof TABS)[number][0];

/** Settings forms report unsaved changes here, so the dialog can stop you leaving (1183). */
const Dirty = createContext<(id: string, dirty: boolean) => void>(() => {});
function useDirty(id: string, dirty: boolean) {
  const mark = useContext(Dirty);
  useEffect(() => {
    mark(id, dirty);
    return () => mark(id, false);
  }, [mark, id, dirty]);
}

/** Restart a CSS animation keyed on a data attribute. */
function replay(el: Element | null | undefined, attr: string) {
  el?.removeAttribute(attr);
  void (el as HTMLElement | null)?.offsetWidth;
  el?.setAttribute(attr, "");
}

export function CommunitySettings({ tab = "about", focusDesc }: { tab?: SettingsTab; focusDesc?: boolean }) {
  const c = useApp((s) => s.cs[s.url]);
  const [dirty, setDirty] = useState<string[]>([]);
  const [nag, setNag] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const mark = useCallback((id: string, d: boolean) => setDirty((l) => (d ? (l.includes(id) ? l : [...l, id]) : l.filter((x) => x !== id))), []);
  if (nag && !dirty.length) setNag(false);
  if (!c?.me) return null;
  const name = c.info?.name ?? hostOf(c.url);
  // Like Discord: stay put, show the unsaved form and shake the dialog.
  const blocked = (to: SettingsTab | null) => {
    const id = unsavedBlock(dirty, tab, to);
    if (!id) return false;
    setNag(true);
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    replay(panel.current?.closest("dialog"), "data-shake");
    replay(panel.current?.querySelector(".unsaved-bar"), "data-shake");
    return true;
  };
  const go = (t: SettingsTab) => !blocked(t) && (set({ modal: { t: "community", tab: t } }), true);
  const forms = () => dirty.map((id) => document.getElementById(id) as HTMLFormElement | null);
  return (
    <Dialog label={`${name} settings`} className="community-settings" guard={() => blocked(null)}>
      <Head title={`${name} settings`} close={() => blocked(null) || set({ modal: null })} />
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
                if (go(next)) requestAnimationFrame(() => document.getElementById(`cs-tab-${next}`)?.focus());
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div role="tabpanel" id="cs-panel" aria-labelledby={`cs-tab-${tab}`} className="cs-panel" ref={panel} data-nag={nag || undefined}>
          <Dirty.Provider value={mark}>
            {tab === "members" && <MembersTab url={c.url} />}
            {tab === "roles" && <RolesTab url={c.url} />}
            {tab === "channels" && <ChannelsTab url={c.url} />}
            {tab === "invites" && <Invites url={c.url} inviteOnly={!!c.info?.inviteOnly} />}
            {tab === "bans" && <BansTab url={c.url} />}
            {tab === "bots" && <BotsTab url={c.url} />}
            {tab === "emoji" && <EmojiTab url={c.url} />}
            {tab === "about" && <AboutTab url={c.url} focusDesc={focusDesc} />}
          </Dirty.Provider>
          {dirty.length > 0 && (
            <div className="unsaved-bar" role="status">
              <span>Careful, you have unsaved changes.</span>
              <button type="button" className="btn ghost small" onClick={() => forms().forEach((f) => f?.reset())}>
                Reset
              </button>
              <button type="button" className="btn primary small" onClick={() => forms().forEach((f) => f?.requestSubmit())}>
                Save changes
              </button>
            </div>
          )}
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

// Fade, as the reduced-motion rule in app.css turns these off.
const FADE = 150;

function BansTab({ url }: { url: string }) {
  const members = useApp((s) => s.cs[url].members);
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [gone, setGone] = useState("");
  const [err, setErr] = useState("");
  const fail = (e: unknown) => setErr(errorText(e));
  const load = () => listBans(url).then(setBans, fail);
  useEffect(() => void load(), [url]);
  const unban = (id: string) => {
    setErr("");
    unbanMember(url, id).then(() => (setGone(id), setTimeout(() => load().then(() => setGone("")), FADE)), fail);
  };
  const now = Date.now();
  return (
    <div className="stack" aria-busy={!bans && !err}>
      <p className="muted small">A banned account can't join again. Unban it and the person may join with the same profile, as a plain member.</p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {!bans && !err && <Skeleton rows={2} avatar={32} className="skel-admin" />}
      {bans && !bans.length && <p className="muted small">Nobody is banned.</p>}
      {!!bans?.length && (
        <ul className="admin-list" aria-label="Banned members" style={{ animation: `fade-in ${FADE}ms ease-out` }}>
          {bans.map(({ member: m, bannedBy, bannedAtMs }) =>
            m ? (
              <li key={m.id} style={{ opacity: gone === m.id ? 0 : 1, transition: `opacity ${FADE}ms ease-out` }}>
                <Avatar m={m} size={32} />
                <span className="truncate">
                  <b>{m.displayName || m.username}</b>
                  <small className="muted">
                    @{m.username} · {banDetail(Number(bannedAtMs), members[bannedBy], now)}
                  </small>
                </span>
                <button className="btn small" aria-label={`Unban ${m.displayName || m.username}`} disabled={gone === m.id} onClick={() => unban(m.id)}>
                  Unban
                </button>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports (1119)
// ---------------------------------------------------------------------------

export function ReportDialog({ url, message: m }: { url: string; message: Message }) {
  const c = useApp((s) => s.cs[url]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  if (!c) return null;
  const author = c.members[m.authorId];
  const dm = c.channels[m.channelId]?.kind === ChannelKind.DM;
  const send = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    reportMessage(url, m.id, note.trim()).then(
      () => setSent(true),
      (x) => (setErr(errorText(x, c.info?.name)), setBusy(false)),
    );
  };
  if (sent)
    return (
      <Dialog label="Report sent" className="confirm report-dialog">
        <h2>Report sent</h2>
        <p className="muted" role="status">
          Thank you. The moderators of {c.info?.name ?? hostOf(url)} can now see it. You will not see what they do, and the author is not told who reported it.
        </p>
        <div className="row-end">
          <button className="btn primary" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
            Done
          </button>
        </div>
      </Dialog>
    );
  return (
    <Dialog label="Report message" className="confirm report-dialog">
      <form onSubmit={send}>
        <h2>Report this message?</h2>
        <blockquote className="delete-preview">
          <b>{author ? author.displayName || author.username : "Former member"}</b> {m.text || "(attachment)"}
        </blockquote>
        <p className="muted">
          {dm
            ? "This is a direct message. Moderators cannot read your direct messages, so a report shares this one message with them, and nothing else from the conversation."
            : "Moderators and admins see the message, your name and your note."}{" "}
          The author is not told who reported it.
        </p>
        <label className="field">
          <span>Note for moderators (optional)</span>
          <textarea className="input" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong with this message?" />
        </label>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="row-end">
          <button type="button" className="btn ghost" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy}>
            Report
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReportsDialog() {
  const c = useApp((s) => s.cs[s.url]);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [resolved, setResolved] = useState(false);
  const [gone, setGone] = useState("");
  const [err, setErr] = useState("");
  const url = c?.url ?? "";
  const fail = (e: unknown) => setErr(errorText(e));
  const load = () => listReports(url, resolved).then(setReports, fail);
  useEffect(() => (setReports(null), void load()), [url, resolved]);
  if (!c) return null;
  const resolve = (id: string) => {
    setErr("");
    resolveReport(url, id).then(() => (setGone(id), setTimeout(() => load().then(() => setGone("")), FADE)), fail);
  };
  const now = Date.now();
  return (
    <Dialog label="Reports" className="reports-dialog">
      <Head title="Reports" />
      <div className="stack" aria-busy={!reports && !err}>
        <p className="muted small">
          Members report messages here. You see reports about members with a lower permission than yours. Resolve a report when you have dealt with it. A
          report of a direct message holds only that message. Resolved reports stay for 90 days.
        </p>
        <div className="seg" role="radiogroup" aria-label="Show">
          {[false, true].map((v) => (
            <label key={String(v)}>
              <input type="radio" name="reports-show" checked={resolved === v} onChange={() => setResolved(v)} />
              {v ? "Resolved" : "Open"}
            </label>
          ))}
        </div>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        {!reports && !err && <Skeleton rows={3} avatar={32} lines={2} className="skel-admin" />}
        {reports && !reports.length && <p className="muted small">{resolved ? "No resolved reports." : "No open reports."}</p>}
        {!!reports?.length && (
          <ul className="admin-list report-list" aria-label={resolved ? "Resolved reports" : "Open reports"} style={{ animation: `fade-in ${FADE}ms ease-out` }}>
            {reports.map((r) => {
              const a = r.author;
              const name = a ? a.displayName || a.username : "Former member";
              const place = reportPlace(r, c.channels);
              const mod = a ? modActions(c.me, c.members[a.id] ?? a) : { remove: false };
              return (
                <li key={r.id} style={{ opacity: gone === r.id ? 0 : 1, transition: `opacity ${FADE}ms ease-out` }}>
                  <Avatar m={a} size={32} />
                  <div className="report-body">
                    <span className="report-head">
                      <b>{name}</b>
                      <small className="muted">
                        {place.label} · {reportDetail(Number(r.reportedAtMs), r.reporter, now)}
                      </small>
                    </span>
                    <blockquote className="delete-preview">{r.message?.text || "(attachment)"}</blockquote>
                    {r.message?.attachments.map((f) => (
                      <a key={f.id} href={absUrl(url, f.url)} target="_blank" rel="noreferrer" className="small">
                        {f.contentType.startsWith("image/") ? (
                          <img src={absUrl(url, f.url)} alt={f.name} style={{ display: "block", maxWidth: 240, maxHeight: 160, borderRadius: 6 }} />
                        ) : (
                          <>
                            <Icon name="file" size={14} /> {f.name}
                          </>
                        )}
                      </a>
                    ))}
                    {r.note && <p className="report-note">“{r.note}”</p>}
                    {r.resolvedAtMs > 0n && <small className="muted">{reportDetail(Number(r.resolvedAtMs), r.resolvedBy, now, "Resolved")}</small>}
                    {!resolved && (
                    <span className="row">
                      {place.open && (
                        <button className="btn small" onClick={() => (set({ modal: null }), jumpTo(url, r.message!, true))}>
                          <Icon name="external" size={14} /> Go to message
                        </button>
                      )}
                      {mod.remove && a && (
                        <button className="btn danger-ghost small" aria-label={`Kick ${name}`} onClick={() => set({ modal: { t: "remove", url, memberId: a.id, ban: false } })}>
                          Kick
                        </button>
                      )}
                      <button className="btn small" aria-label={`Resolve report about ${name}`} disabled={gone === r.id} onClick={() => resolve(r.id)}>
                        <Icon name="check" size={14} /> Resolve
                      </button>
                    </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function TokenOnce({ who, token, onDone }: { who: string; token: string; onDone: () => void }) {
  return (
    <div className="token-once" role="status">
      <b>Token for {who}</b>
      <p className="small">Copy it now. Sblurp shows it only once. Anyone with it can post as {who}.</p>
      <div className="copy-row">
        <input className="input" readOnly value={token} aria-label={`Token for ${who}`} onFocus={(e) => e.target.select()} />
        <CopyButton text={token} />
      </div>
      <button className="btn ghost small" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function BotsTab({ url }: { url: string }) {
  const [all, setBots] = useState<Member[] | null>(null);
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [token, setToken] = useState<{ who: string; token: string } | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", bio: "" });
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const rev = useApp((s) => s.cs[url]?.pluginsRev ?? 0);
  const fail = (e: unknown) => setErr(errorText(e));
  const load = () => Promise.all([listBots(url).then(setBots), listPlugins(url).then(setPlugins)]).catch(fail);
  useEffect(() => void load(), [url, rev]);
  const bots = all && plugins ? tokenBots(all, plugins) : null;
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
    <div className="stack" aria-busy={!bots && !err}>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {plugins ? <Plugins url={url} plugins={plugins} reload={load} /> : !err && <Skeleton rows={2} avatar={32} className="skel-admin" />}
      <h3>Token bots</h3>
      <p className="muted small">
        A token bot runs on your own computer and posts with a token, using the same API as this app. Run one with the example in the server
        README.
      </p>
      {token && <TokenOnce {...token} onDone={() => setToken(null)} />}
      {!bots && !err && <Skeleton rows={2} avatar={32} className="skel-admin" />}
      {bots && !bots.length && <p className="muted small">No token bots yet.</p>}
      {!!bots?.length && (
        <ul className="admin-list" aria-label="Token bots">
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
        <h3>Add a token bot</h3>
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
              autoComplete="off"
              data-1p-ignore
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

/** JavaScript plugins that run inside the server (1090). Each one is a bot named after its file. */
function Plugins({ url, plugins, reload }: { url: string; plugins: Plugin[]; reload: () => Promise<unknown> }) {
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [picked, setPicked] = useState("");
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const formErr = pluginFormError(name, source);
  const replaces = plugins.some((p) => p.name === name);
  const pick = async (f?: File) => {
    if (!f) return;
    setPicked(f.name);
    setSource(await f.text());
    if (!name) setName(pluginNameFromFile(f.name));
  };
  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
    }
    await reload();
    setBusy(false);
  };
  const install = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await installPlugin(url, name, source);
      setName("");
      setSource("");
      setPicked("");
      if (file.current) file.current.value = "";
    });
  };
  return (
    <section className="stack plugins">
      <h3>Plugins</h3>
      <p className="muted small">
        A plugin is a JavaScript file that runs inside this server as a bot. It can answer commands, greet people and check who joins.{" "}
        <a href="https://sblurp.chat/docs/plugins" target="_blank" rel="noreferrer">
          How to write one <Icon name="external" size={14} />
        </a>
        {" "}
        <a href="https://sblurp.chat/docs/plugins#make-one-with-ai" target="_blank" rel="noreferrer">
          How to make one with AI <Icon name="external" size={14} />
        </a>
      </p>
      {!plugins.length && <p className="muted small">No plugins yet.</p>}
      {!!plugins.length && (
        <ul className="admin-list" aria-label="Plugins">
          {plugins.map((p) => {
            const st = pluginStatus(p);
            return (
              <li key={p.name} className="plugin-row">
                <span className="plugin-icon" data-tone={st.tone}>
                  <Icon name="puzzle" size={18} />
                </span>
                <span className="truncate">
                  <b>{p.name}</b>
                  <small className="plugin-status" data-tone={st.tone}>
                    {st.label}
                  </small>
                  {p.error && p.enabled && <code className="plugin-error">{p.error}</code>}
                </span>
                {confirm === p.name ? (
                  <span className="row">
                    <button className="btn ghost small" onClick={() => setConfirm("")}>
                      Keep
                    </button>
                    <button className="btn danger small" disabled={busy} onClick={() => act(() => deletePlugin(url, p.name)).then(() => setConfirm(""))}>
                      Delete {p.name}
                    </button>
                  </span>
                ) : (
                  <span className="row">
                    <input
                      type="checkbox"
                      role="switch"
                      className="switch"
                      aria-label={`Run ${p.name}`}
                      checked={p.enabled}
                      disabled={busy}
                      onChange={(e) => act(() => setPluginEnabled(url, p.name, e.target.checked))}
                    />
                    <button className="btn danger-ghost small" aria-label={`Delete ${p.name}`} onClick={() => setConfirm(p.name)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="bot-new stack" onSubmit={install}>
        <h3>Install a plugin</h3>
        <div className="row-fields">
          <div className="field">
            <b>File</b>
            <label
              className="dropzone file-pick"
              data-over={over || undefined}
              onDragOver={(e) => (e.preventDefault(), setOver(true))}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => (e.preventDefault(), setOver(false), void pick(e.dataTransfer.files[0]))}
            >
              <input ref={file} type="file" accept=".js,text/javascript" className="visually-hidden" onChange={(e) => pick(e.target.files?.[0])} />
              <span className="btn small">
                <Icon name="upload" size={16} /> Choose a .js file
              </span>
              <span className="truncate muted small">{picked || "or drop one here"}</span>
            </label>
          </div>
          <label className="field">
            <b>Name</b>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value.trim().toLowerCase())}
              placeholder="dice"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
        </div>
        <label className="field">
          <b>Source</b>
          <textarea
            className="input textarea plugin-source"
            rows={6}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={'function onCommand(name, args) {\n  if (name === "hello") return "Hi!";\n}'}
            spellCheck={false}
          />
        </label>
        {replaces && (
          <p className="update-note" style={{ animation: "fade-in 150ms ease-out" }}>
            <Icon name="info" size={16} />
            <span>This replaces the installed {name} plugin. If the new code does not load, the old one keeps running.</span>
          </p>
        )}
        {err && (
          <p className="error" role="alert" style={{ animation: "fade-in 150ms ease-out" }}>
            {err}
          </p>
        )}
        <div className="row-end">
          {(name || source) && formErr && <small className="muted">{formErr}</small>}
          <button className="btn primary" disabled={busy || !!formErr}>
            <Icon name="upload" size={16} /> {replaces ? "Replace" : "Install"}
          </button>
        </div>
      </form>
    </section>
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
  const copy = (code: string) => navigator.clipboard.writeText(shareInviteLink(AUTH_URL, url, code)).then(() => setCopied(code));
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
    <div className="invites" aria-busy={!list && !err}>
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
      {!list && !err && <Skeleton rows={3} className="skel-admin" />}
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
                    <Icon name={copied === i.code ? "check" : "copy"} size={16} /> <span aria-live="polite">{copied === i.code ? "Copied" : "Copy"}</span>
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

// ---------------------------------------------------------------------------
// Roles and channel access (ticket 1011). Roles only decide who sees which channels;
// the Permission rank decides what people may do.
// ---------------------------------------------------------------------------

/** A member's roles as chips. Admins get checkboxes to give or take roles. */
export function RoleChips({ url, m, edit }: { url: string; m: Member; edit: boolean }) {
  const roles = useApp((s) => s.cs[url]?.roles ?? NO_ROLES);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const mine = memberRoles(m, roles);
  const name = m.displayName || m.username;
  const toggle = (id: string, on: boolean) => {
    setErr("");
    const ids = on ? [...m.roleIds, id] : m.roleIds.filter((r) => r !== id);
    setMemberRoles(url, m.id, ids).catch((x) => setErr(errorText(x)));
  };
  return (
    <div className="role-chips">
      <ul aria-label={`${name}'s roles`}>
        {mine.map((r) => (
          <li key={r.id} className="role-chip" style={{ ["--role" as string]: r.color || "var(--graphite)" }}>
            {r.name}
          </li>
        ))}
        {!mine.length && <li className="muted small">No roles</li>}
        {edit && (
          <li>
            <button className="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Done" : "Edit roles"}
            </button>
          </li>
        )}
      </ul>
      {edit && open && (
        <fieldset className="role-checks">
          <legend className="visually-hidden">Roles for {name}</legend>
          {roles.map((r) => (
            <label key={r.id}>
              <input type="checkbox" checked={m.roleIds.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
              <span className="role-dot" style={{ ["--role" as string]: r.color || "var(--graphite)" }} />
              {r.name}
            </label>
          ))}
          {!roles.length && <p className="muted small">No roles yet. Create them in Community settings.</p>}
        </fieldset>
      )}
      {err && (
        <p className="error small" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
const NO_ROLES: Role[] = [];

function RolesTab({ url }: { url: string }) {
  const c = useApp((s) => s.cs[url]);
  const [f, setF] = useState({ name: "", color: "#3550f0" });
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState("");
  const fail = (x: unknown) => setErr(errorText(x));
  const counts = (id: string) => Object.values(c.members).filter((m) => m.roleIds.includes(id)).length;
  const make = (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    createRole(url, f.name.trim(), f.color).then(() => setF({ ...f, name: "" }), fail);
  };
  // Positions become the list index, so equal or sparse positions reorder predictably.
  const move = async (i: number, d: -1 | 1) => {
    const order = c.roles.slice();
    [order[i], order[i + d]] = [order[i + d], order[i]];
    setErr("");
    try {
      for (const [p, r] of order.entries()) if (r.position !== p) await updateRole(url, r.id, { position: p });
    } catch (x) {
      fail(x);
    }
  };
  return (
    <div className="stack">
      <p className="muted small">Roles decide who can see which channels. What someone may do comes from their Permission, on the Members tab.</p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {c.roles.length > 0 && (
        <ul className="admin-list roles-list" aria-label="Roles">
          {c.roles.map((r, i) => (
            <li key={r.id}>
              <input
                type="color"
                className="role-color"
                aria-label={`Color for ${r.name}`}
                value={r.color || "#5d6274"}
                onChange={(e) => updateRole(url, r.id, { color: e.target.value }).catch(fail)}
              />
              <span className="truncate">
                <input
                  className="input small"
                  aria-label={`Name of ${r.name}`}
                  defaultValue={r.name}
                  key={r.name}
                  onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.name && updateRole(url, r.id, { name: e.target.value.trim() }).catch(fail)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <small className="muted">{count(counts(r.id), "member", "members")}</small>
              </span>
              {confirm === r.id ? (
                <span className="row">
                  <button className="btn ghost small" onClick={() => setConfirm("")}>
                    Keep
                  </button>
                  <button className="btn danger small" onClick={() => deleteRole(url, r.id).then(() => setConfirm(""), (x) => (setConfirm(""), fail(x)))}>
                    Delete {r.name}
                  </button>
                </span>
              ) : (
                <span className="row">
                  <button className="icon-btn flip" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button className="icon-btn" aria-label={`Move ${r.name} down`} disabled={i === c.roles.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="chevron" size={16} />
                  </button>
                  <button className="btn danger-ghost small" aria-label={`Delete ${r.name}`} onClick={() => setConfirm(r.id)}>
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="stack" onSubmit={make}>
        <h3>Create a role</h3>
        <div className="row-fields">
          <label className="field">
            <span>Name</span>
            <input className="input" required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Film club" />
          </label>
          <label className="field">
            <span>Color</span>
            <input type="color" className="role-color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
          </label>
        </div>
        <button className="btn primary" disabled={!f.name.trim()}>
          Create role
        </button>
      </form>
      <p className="muted small">Give someone a role from their profile: click their name, then Edit roles.</p>
    </div>
  );
}

function ChannelsTab({ url }: { url: string }) {
  const c = useApp((s) => s.cs[url]);
  const [chans, setChans] = useState<Channel[] | null>(null);
  const [err, setErr] = useState("");
  const fail = (x: unknown) => setErr(errorText(x));
  useEffect(() => {
    browseChannels(url).then(setChans, (x) => setErr(errorText(x)));
  }, [url]);
  const optIn = c.mode === ChannelMode.OPT_IN;
  const access = (ch: Channel, roleIds: string[], isDefault: boolean) => {
    setErr("");
    setChannelAccess(url, ch.id, roleIds, isDefault).then((n) => n && setChans((l) => l && l.map((x) => (x.id === n.id ? n : x))), fail);
  };
  const text = (chans ?? []).filter((ch) => ch.kind === ChannelKind.TEXT).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="stack">
      <fieldset className="mode-pick">
        <legend>How people get channels</legend>
        {[
          [ChannelMode.ROLES, "Everyone is in every channel they can see", "Like Discord. Roles decide what each person sees, and there is nothing to join."],
          [ChannelMode.OPT_IN, "People pick the channels they join", "Like Slack. People browse the channels they can see and join or leave them. New members start in the default channels."],
        ].map(([m, title, help]) => (
          <label key={m} className="mode-opt">
            <input type="radio" name="mode" checked={c.mode === m} onChange={() => setChannelMode(url, m as ChannelMode).catch(fail)} />
            <span>
              <b>{title}</b>
              <small>{help}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <h3>Who can see each channel</h3>
      {!chans && !err && <Skeleton rows={4} className="skel-admin" />}
      <ul className="access-list" aria-label="Channel access" aria-busy={!chans && !err}>
        {text.map((ch) => {
          const who = c.roles.filter((r) => ch.roleIds.includes(r.id)).map((r) => r.name);
          return (
            <li key={ch.id}>
              <details>
                <summary>
                  <b>#{ch.name}</b>
                  <small className="muted">
                    {who.length ? who.join(", ") : "Everyone"}
                    {optIn && ch.isDefault ? ", joined by default" : ""}
                  </small>
                </summary>
                <fieldset className="role-checks">
                  <legend>Only people with these roles (none ticked means everyone). Admins always see it.</legend>
                  {c.roles.map((r) => (
                    <label key={r.id}>
                      <input
                        type="checkbox"
                        checked={ch.roleIds.includes(r.id)}
                        onChange={(e) => access(ch, e.target.checked ? [...ch.roleIds, r.id] : ch.roleIds.filter((x) => x !== r.id), ch.isDefault)}
                      />
                      <span className="role-dot" style={{ ["--role" as string]: r.color || "var(--graphite)" }} />
                      {r.name}
                    </label>
                  ))}
                  {!c.roles.length && <p className="muted small">No roles yet. Create one on the Roles tab to limit a channel.</p>}
                </fieldset>
                {optIn && (
                  <label className="toggle-row">
                    <span>
                      <b>Join by default</b>
                      <small>New members start in this channel.</small>
                    </span>
                    <input type="checkbox" role="switch" className="switch" checked={ch.isDefault} onChange={(e) => access(ch, ch.roleIds, e.target.checked)} />
                  </label>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
