// The iOS app's notification sheet and Settings row (ticket 1428). Logic in push.ts.
import { useEffect, useSyncExternalStore } from "react";
import { isDM } from "./logic";
import { enablePush, notNowPush, offerPush, onPush, pushState, setPush } from "./push";
import { useApp } from "./store";
import { Dialog, Icon } from "./ui";

/** Explains notifications before the one-time iOS prompt. Opening a DM is a moment to ask. */
export function PushAsk() {
  const { asking } = useSyncExternalStore(onPush, pushState);
  const dm = useApp((s) => isDM(s.cs[s.url]?.channels[s.channelId]));
  useEffect(() => {
    if (dm) offerPush();
  }, [dm]);
  if (!asking) return null;
  return (
    <Dialog label="Turn on notifications" className="confirm" onClose={notNowPush}>
      <h2>
        <Icon name="bell" /> Sblurp would like to send you notifications
      </h2>
      <p className="muted">Know when someone mentions you or sends you a direct message, even when Sblurp is closed.</p>
      <div className="row-end">
        <button className="btn ghost" onClick={notNowPush}>
          Not now
        </button>
        <button className="btn primary" autoFocus onClick={enablePush}>
          Enable
        </button>
      </div>
    </Dialog>
  );
}

/** The Notifications settings in the iOS app. Denied by iOS: the row opens the iOS Settings app. */
export function PushSetting() {
  const { status, on } = useSyncExternalStore(onPush, pushState);
  const denied = status === "denied";
  return (
    <section>
      <h3>
        Notifications <small className="scope">On this device</small>
      </h3>
      {denied ? (
        <button className="toggle-row" onClick={() => setPush(true)}>
          <span>
            <b>Mentions and direct messages</b>
            <small>Notifications are off for Sblurp in iOS Settings. Tap to open Settings.</small>
          </span>
          <Icon name="external" />
        </button>
      ) : (
        <label className="toggle-row">
          <span>
            <b>Mentions and direct messages</b>
            <small>Get an alert when Sblurp is not open.</small>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={on} disabled={status === "unknown"} onChange={(e) => setPush(e.target.checked)} />
        </label>
      )}
    </section>
  );
}
