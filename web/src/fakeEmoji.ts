// Custom emoji for ?fake=1: a few drawn ones plus a generated pack big enough to exercise the
// picker and the settings grid (about 1,500 in Sblurp Community).
import type { Emoji } from "./CustomEmoji";

const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;
const badge = (bg: string, fg: string, text: string, size = 22) =>
  svg(`<rect x="2" y="12" width="60" height="40" rx="12" fill="${bg}"/><text x="32" y="${32 + size * 0.36}" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="${size}" text-anchor="middle" fill="${fg}">${text}</text>`);

const DRAWN: Record<string, string> = {
  sblurp: svg(
    `<path d="M40 2 34 22" stroke="#E8344E" stroke-width="5" stroke-linecap="round"/><path d="M14 20h36l-5 38a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4z" fill="#3550F0"/><path d="M14 20h36l-1.4 10H15.4z" fill="#DCE2FD"/><circle cx="26" cy="42" r="3" fill="#fff"/><circle cx="38" cy="47" r="2" fill="#fff"/>`,
  ),
  lgtm: badge("#1F9D55", "#fff", "LGTM", 21),
  plus_one: badge("#3550F0", "#fff", "+1", 28),
  shipit: svg(
    `<path d="M8 26 32 14l24 12v24L32 62 8 50z" fill="#C98A4B"/><path d="M8 26l24 12 24-12M32 38v24" stroke="#8A5A2B" stroke-width="3" fill="none"/><path d="M32 2v22M24 10l8-8 8 8" stroke="#E8344E" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  ),
  party_blob: svg(
    `<path d="M32 18c16 0 26 10 26 24S48 62 32 62 6 56 6 42s10-24 26-24z" fill="#FFC83D"/><path d="M24 2 36 20H14z" fill="#E8344E"/><circle cx="24" cy="2" r="3" fill="#3550F0"/><circle cx="23" cy="38" r="4" fill="#1A1C2B"/><circle cx="41" cy="38" r="4" fill="#1A1C2B"/><path d="M22 48q10 9 20 0" stroke="#1A1C2B" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  ),
  this: svg(
    `<path d="M32 4 54 28H40v12H24V28H10z" fill="#E8344E"/><text x="32" y="60" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="17" text-anchor="middle" fill="#E8344E">THIS</text>`,
  ),
  catjam: svg(
    `<path d="M10 8l12 12h20L54 8v30c0 14-10 22-22 22S10 52 10 38z" fill="#F29A3E"/><circle cx="24" cy="34" r="4" fill="#1A1C2B"/><circle cx="40" cy="34" r="4" fill="#1A1C2B"/><path d="M28 44l4 3 4-3" stroke="#1A1C2B" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M2 40h10M2 46h10M52 40h10M52 46h10" stroke="#1A1C2B" stroke-width="2"/>`,
  ),
  owl_hoot: svg(
    `<path d="M12 10l10 8h20l10-8v34c0 10-9 18-20 18S12 54 12 44z" fill="#6F5BD9"/><circle cx="24" cy="32" r="8" fill="#fff"/><circle cx="40" cy="32" r="8" fill="#fff"/><circle cx="24" cy="32" r="4" fill="#1A1C2B"/><circle cx="40" cy="32" r="4" fill="#1A1C2B"/><path d="M29 42l3 5 3-5z" fill="#FFC83D"/>`,
  ),
  moon_coffee: svg(
    `<path d="M10 26h34v18a14 14 0 0 1-14 14h-6a14 14 0 0 1-14-14z" fill="#8A5A2B"/><path d="M44 30h4a6 6 0 0 1 0 12h-4" stroke="#8A5A2B" stroke-width="4" fill="none"/><path d="M40 4a12 12 0 1 0 14 14 10 10 0 0 1-14-14z" fill="#FFC83D"/>`,
  ),
};

const ANIMALS = ["blob", "cat", "dog", "frog", "parrot", "duck", "bean", "pixel", "meow", "bear"];
const MOODS = ["wave", "dance", "yes", "no", "heart", "sad", "cool", "think", "clap", "spin", "shrug", "love", "fire", "ok", "zoom"];

function face(i: number, j: number, n: number) {
  const hue = (i * 37 + n * 23) % 360;
  const mouth = ["M22 44q10 8 20 0", "M22 48q10-8 20 0", "M24 46h16", "M26 44a6 6 0 0 0 12 0z"][j % 4];
  const eyes = j % 3 === 2 ? `<path d="M18 30h10M36 30h10" stroke="#1A1C2B" stroke-width="4" stroke-linecap="round"/>` : `<circle cx="23" cy="30" r="4" fill="#1A1C2B"/><circle cx="41" cy="30" r="4" fill="#1A1C2B"/>`;
  const shape = i % 2 ? `<rect x="6" y="6" width="52" height="52" rx="16" fill="hsl(${hue} 70% 62%)"/>` : `<circle cx="32" cy="32" r="27" fill="hsl(${hue} 72% 60%)"/>`;
  return svg(`${shape}${eyes}<path d="${mouth}" stroke="#1A1C2B" stroke-width="4" fill="none" stroke-linecap="round"/>`);
}

let cache: Record<string, Emoji[]> | null = null;

export function fakeEmoji(url: string): Emoji[] {
  if (!cache) {
    const pack: Emoji[] = [];
    ANIMALS.forEach((a, i) =>
      MOODS.forEach((m, j) => {
        for (let n = 1; n <= 10; n++) pack.push({ name: n === 1 ? `${a}_${m}` : `${a}_${m}_${n}`, src: face(i, j, n) });
      }),
    );
    const drawn = (names: string[]) => names.map((name) => ({ name, src: DRAWN[name] }));
    const byName = (l: Emoji[]) => l.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    cache = {
      "https://community.sblurp.chat": byName([...drawn(["sblurp", "lgtm", "plus_one", "shipit", "party_blob", "this", "catjam"]), ...pack]),
      "https://nightowls.chat": byName(drawn(["owl_hoot", "moon_coffee", "sblurp"])),
    };
  }
  return cache[url] ?? [];
}
