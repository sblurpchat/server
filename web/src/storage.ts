// localStorage for per-viewer conveniences. Every access may throw in private modes or with
// storage blocked; then reads find nothing and writes last for this session only.
export const readKey = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
/** null removes the key. */
export const writeKey = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // blocked or full: forgotten after this session
  }
};
