// Setup wizard for a brand-new community (1286): pick a template, adjust the basics, apply.
import { useEffect, useState } from "react";
import { MemberRole } from "./gen/sblurp/v1/sblurp_pb";
import { applyTemplate, errorText, finishSetup, get, set, useApp } from "./store";
import { TEMPLATES, templateChannels, type Template } from "./templates";
import { Dialog, Icon } from "./ui";
import "./setup.css";

const offered = new Set<string>();

/** Opens the wizard once per session for the owner of a community that still needs setup. */
export function useSetupPrompt() {
  const url = useApp((s) => s.url);
  const c = useApp((s) => s.cs[s.url]);
  const ready = !!c?.info?.needsSetup && c.me?.role === MemberRole.OWNER && c.status === "live";
  useEffect(() => {
    if (!ready || offered.has(url) || get().modal) return;
    offered.add(url);
    set({ modal: { t: "setup" } });
  }, [ready, url]);
}

export function SetupWizard() {
  const url = useApp((s) => s.url);
  const info = useApp((s) => s.cs[s.url]?.info);
  const name = info?.name ?? "your community";
  const [step, setStep] = useState<"pick" | "details" | "done">("pick");
  const [t, setT] = useState<Template>(TEMPLATES[0]);
  const [desc, setDesc] = useState("");
  const [inviteOnly, setInviteOnly] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (f: () => Promise<void>, then: () => void) => {
    setBusy(true);
    setErr("");
    try {
      await f();
      then();
    } catch (e) {
      setErr(errorText(e, name));
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    setDesc(info?.description || t.description);
    setInviteOnly(t.inviteOnly);
    setMessage(t.message.replaceAll("{name}", name));
    setErr("");
    setStep("details");
  };
  const close = () => set({ modal: null });
  const chans = templateChannels(t);
  const added = chans.length - 1;

  return (
    <Dialog label={`Set up ${name}`} className="setup" guard={() => busy}>
      {step === "pick" && (
        <div className="setup-step" key="pick">
          <h2>Set up {name}</h2>
          <p className="muted">Pick a starting point. You can rename, add or remove anything later.</p>
          <fieldset className="tpl-grid">
            <legend className="visually-hidden">Template</legend>
            {TEMPLATES.map((x) => (
              <label key={x.id} className="tpl">
                <input type="radio" name="tpl" value={x.id} checked={x === t} onChange={() => setT(x)} autoFocus={x === t} />
                <span className="tpl-head">
                  <Icon name={x.icon} size={18} />
                  <b>{x.name}</b>
                </span>
                <span className="tpl-blurb">{x.blurb}</span>
                <Preview t={x} />
              </label>
            ))}
          </fieldset>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <div className="setup-foot">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => finishSetup(url), close)}>
              Skip setup
            </button>
            <button type="button" className="btn primary" onClick={next}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "details" && (
        <form
          className="setup-step stack"
          key="details"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => applyTemplate(url, t, { description: desc, inviteOnly, message }), () => setStep("done"));
          }}
        >
          <div>
            <h2>Make it yours</h2>
            <p className="muted">
              {t.id === "scratch" ? "You'll start with #general." : `${t.name} adds ${added} channels and keeps #general.`} People see this when they join.
            </p>
          </div>
          <div className="field">
            <label htmlFor="setup-desc">
              <b>Description</b>
            </label>
            <textarea id="setup-desc" className="input textarea" rows={2} maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is this community for?" />
            <small className="muted">One or two sentences on what this place is for. Shown under the name in the sidebar.</small>
          </div>
          <label className="toggle-row">
            <span>
              <b>Invite only</b>
              <small>{inviteOnly ? "People need an invite link from you or an admin." : "Anyone with a sblurp.chat account and the address can join."}</small>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={inviteOnly} onChange={(e) => setInviteOnly(e.target.checked)} />
          </label>
          <div className="field">
            <label htmlFor="setup-msg">
              <b>Welcome message in #{t.welcome}</b>
            </label>
            <textarea id="setup-msg" className="input textarea" rows={5} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
            <small className="muted">Posted as you, so newcomers know where to start. Clear it to skip.</small>
          </div>
          {err && (
            <p className="error" role="alert">
              {err} Channels made so far stay. Try again to finish.
            </p>
          )}
          <div className="setup-foot">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => (setErr(""), setStep("pick"))}>
              Back
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? "Setting up…" : `Set up ${name}`}
            </button>
          </div>
        </form>
      )}

      {step === "done" && (
        <div className="setup-step" key="done">
          <h2>{name} is ready</h2>
          <p className="muted">A few things make a new community feel alive.</p>
          <ul className="next-steps">
            <NextStep icon="invite" title="Invite people" hint="Send a link to the first few members." onClick={() => set({ modal: { t: "invite" } })} />
            <NextStep icon="image" title="Add an icon and banner" hint="So people spot it in their rail." onClick={() => set({ modal: { t: "community", tab: "about" } })} />
            <NextStep icon="puzzle" title="Add a bot" hint="Greet newcomers, roll dice or post updates." onClick={() => set({ modal: { t: "community", tab: "bots" } })} />
          </ul>
          <div className="setup-foot">
            <span />
            <button type="button" className="btn primary" autoFocus onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Preview({ t }: { t: Template }) {
  return (
    <span className="tpl-preview" aria-hidden="true">
      {t.sections.map(([cat, chans]) => (
        <span key={cat} className="tpl-sec">
          {cat && <span className="tpl-cat">{cat}</span>}
          {chans.map((ch) => (
            <span key={ch.name} className="tpl-chan">
              <Icon name={ch.private ? "lock" : "hash"} size={13} />
              {ch.name}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function NextStep({ icon, title, hint, onClick }: { icon: "invite" | "image" | "puzzle"; title: string; hint: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="next-step" onClick={onClick}>
        <span className="next-icon">
          <Icon name={icon} size={18} />
        </span>
        <span className="next-text">
          <b>{title}</b>
          <small>{hint}</small>
        </span>
        <Icon name="chevron" size={16} />
      </button>
    </li>
  );
}
