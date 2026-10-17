import { useEffect, useState } from "react";
import type { LinkPreview, Message } from "./gen/sblurp/v1/sblurp_pb";
import { mayPreview, shownPreviews } from "./logic";
import { absUrl, api } from "./store";
import "./link-preview.css";

// Link previews (1110). The community server fetches and caches them, and serves the image itself,
// so the browser never contacts the linked site. One request per message version, kept for the session.
const asked = new Map<string, Promise<LinkPreview[]>>();
const got = new Map<string, LinkPreview[]>();

function load(url: string, m: Message, k: string) {
  let p = asked.get(k);
  if (!p) {
    p = api(url)
      .chat.getLinkPreviews({ messageId: m.id })
      .then(
        (r) => (got.set(k, r.previews), r.previews),
        () => (asked.delete(k), []), // try again next time the message shows
      );
    asked.set(k, p);
  }
  return p;
}

export function LinkPreviews({ url, m }: { url: string; m: Message }) {
  const k = `${url} ${m.id} ${m.editedAtMs}`;
  const skip = m.seq === 0n || m.deleted || !mayPreview(m.text);
  const app = location.origin + location.pathname;
  const [ps, setPs] = useState(() => shownPreviews(got.get(k) ?? [], app));
  useEffect(() => {
    if (skip) return setPs([]);
    let live = true;
    void load(url, m, k).then((x) => live && setPs(shownPreviews(x, app)));
    return () => {
      live = false;
    };
  }, [k, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  if (skip || !ps.length) return null;
  return ps.map((p) => <Card key={p.url} base={url} p={p} />);
}

function Card({ base, p }: { base: string; p: LinkPreview }) {
  const [img, setImg] = useState(!!p.imageUrl);
  return (
    <div className="lp">
      <div className="lp-text">
        <span className="lp-site truncate">{p.siteName}</span>
        <a className="lp-title" href={p.url} target="_blank" rel="noopener noreferrer">
          {p.title}
        </a>
        {p.description && <p className="lp-desc">{p.description}</p>}
      </div>
      {img && (
        <a className="lp-thumb" href={p.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
          <img src={absUrl(base, p.imageUrl)} alt="" loading="lazy" decoding="async" onError={() => setImg(false)} />
        </a>
      )}
    </div>
  );
}
