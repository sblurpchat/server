// The picture at the top of Edit profile (1042). Click or drop an image: it
// is shrunk, uploaded to this community, and saved with the rest of the form
// as UpdateProfile.avatar_url. "Use sblurp.chat picture" goes back to the
// account's.
import { useRef, useState } from "react";
import "./avatar-field.css";
import { shrinkImage } from "./avatar";
import type { Member } from "./gen/sblurp/v1/sblurp_pb";
import { bannerFileError } from "./logic";
import { absUrl, errorText, upload, useApp } from "./store";
import { Alert, Avatar, AvatarEditOverlay, Icon, useDrop } from "./ui";

/** value: the avatar_url to save, or null for no change. */
export function AvatarField({ url, me, name, value, onChange, onBusy, autoFocus }: {
  url: string;
  me: Member;
  name: string;
  value: string | null;
  onChange: (v: string) => void;
  onBusy: (busy: boolean) => void;
  autoFocus?: boolean;
}) {
  const account = useApp((s) => s.profile?.avatarUrl);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, drop] = useDrop((d) => void pick(d.files[0]));
  const [err, setErr] = useState("");
  const shown = value === null ? me.avatarUrl : absUrl(url, value);
  const pick = async (file?: File) => {
    if (!file) return;
    setErr("");
    setBusy(true);
    onBusy(true);
    try {
      const f = await shrinkImage(file);
      const bad = bannerFileError(f);
      if (bad) setErr(bad);
      else onChange((await upload(url, f)).url);
    } catch (x) {
      setErr(errorText(x, name));
    }
    setBusy(false);
    onBusy(false);
  };
  return (
    <div
      className="field avatar-field"
      data-over={over || undefined}
      {...drop}
    >
      <b id="pic-label">Picture</b>
      <div className="avatar-field-row">
        <button type="button" className="avatar-field-pic avatar-edit" aria-label="Change picture" disabled={busy} autoFocus={autoFocus} onClick={() => input.current?.click()}>
          <Avatar key={shown} m={{ ...me, avatarUrl: shown }} size={72} />
          <AvatarEditOverlay />
          <span className="avatar-field-badge">
            <Icon name="image" size={16} />
          </span>
        </button>
        <div className="avatar-field-side">
          <span className="row">
            <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Uploading…" : "Upload picture"}
            </button>
            {account !== undefined && shown !== account && (
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => onChange(account)}>
                Use sblurp.chat picture
              </button>
            )}
          </span>
          <small className="muted">Click or drop an image. Big photos are made smaller first.</small>
        </div>
      </div>
      <Alert text={err} />
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic"
        aria-labelledby="pic-label"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
