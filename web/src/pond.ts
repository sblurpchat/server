// The sign-in screen's chat wall and holo logo (1242), ported from the marketing home page
// (auth/cmd/auth/static/home.js). Rows of chat drift sideways behind the copy and now and then one
// phrase types itself in bright. The logo card tilts toward a mouse or pen; CSS drifts it otherwise.
// Returns a cleanup. Reduced motion draws one still frame and leaves the logo flat.

const EN = ["hey that's cool", "how are you?", "i really like this", "good morning!", "lol same", "brb, coffee", "nice one", "welcome in!", "see you tonight", "that's so good",
  "thanks!!", "gg", "omg yes", "who's around?", "congrats!!", "happy friday", "made it!", "on my way", "you're the best", "this is great", "ha, love it", "same here",
  "night all", "morning folks", "anyone up?", "just shipped it", "tell me more", "that's wild", "so true", "nailed it", "welcome back!", "miss you all",
  "pizza tonight?", "count me in", "aww thank you", "big mood", "how was the trip?", "looks amazing", "can't wait", "no worries", "you got this", "hi everyone!",
  "great call", "ok that's funny", "let's do it", "back in 5", "happy birthday!", "sounds good", "good luck today", "proud of you", "oh nice", "i'm in",
  "show us!", "what a day", "ty!", "agreed", "yesss", "hello friends", "long time no see", "first time here", "cute dog!", "love this server", "it works!", "cheers!",
  "glhf", "gg wp", "one more game?", "clutch!", "afk 2 min", "rematch?", "pog", "queue up?", "lfg"];
const INTL = ["¿cómo estás?", "¡hola a todos!", "ça va ?", "merci !", "wie geht's?", "danke!", "que legal!", "obrigado!", "che bello!", "ciao a tutti", "hej hej", "kumusta?", "cześć!", "привіт усім!"];
const CJK = ["你好！", "哈哈哈", "太好了", "加油！", "謝謝！", "晚安～", "こんにちは！", "ありがとう！", "すごい！", "안녕하세요!", "고마워요", "ㅋㅋㅋ"];
// Same tuning as the home page: new messages per second, glow px, text px, row spacing, typed chars per second.
const RATE = 2.5, GLOW = 14, SIZE = 15, GAP = 1.75, TYPING = 28, FONT = `${SIZE}px "Geist Mono", ui-monospace, monospace`;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const phrase = () => { const r = Math.random(); return r < 0.08 ? pick(INTL) : r < 0.14 ? pick(CJK) : pick(EN); };
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

type Row = { y: number; s: string; w: number; starts: [number, string, number][]; off: number; v: number };
type Spot = { r: Row; i: number; p: string; pw: number; age: number };
type Box = [number, number, number, number];

export function pond(hero: HTMLElement, logo: HTMLElement, copy: HTMLElement[]): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches, darkQ = matchMedia("not (prefers-color-scheme: light)");
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!, mask = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "pond-fx";
  hero.prepend(canvas);
  let W = 0, H = 0, rows: Row[] = [], spots: Spot[] = [], spotAt = 0, last = 0, raf = 0, boxes: Box[] = [], hi = "", mid = "";
  let lx = 0, ly = 0, lr = 0;
  const rgba = (c: string, a: number) => c.replace(")", ` / ${a})`);
  const hidden = (x: number, y: number, w: number) => boxes.some(([bx, by, bw, bh]) => x + w > bx && x < bx + bw && y > by && y < by + bh);

  function reset() {
    const dpr = Math.min(2, devicePixelRatio || 1), h = hero.getBoundingClientRect(), l = logo.getBoundingClientRect();
    // The sign-in screen follows the system scheme (.signin sets color-scheme: light dark).
    [hi, mid] = darkQ.matches ? ["rgb(200 251 208)", "rgb(49 200 67)"] : ["rgb(14 122 38)", "rgb(24 158 51)"];
    W = hero.clientWidth; H = hero.clientHeight;
    lx = l.left - h.left + l.width / 2; ly = l.top - h.top + l.height / 2; lr = l.width / 2;
    boxes = copy.map((e) => { const b = e.getBoundingClientRect(); return [b.left - h.left - 16, b.top - h.top - 10, b.width + 32, b.height + 20]; });
    canvas.width = mask.width = W * dpr; canvas.height = mask.height = H * dpr;
    // Alpha mask: bright near the logo, quiet at the edges, feathered holes behind the copy.
    const m = mask.getContext("2d")!;
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = m.createRadialGradient(lx, ly, lr * 0.9, lx, ly, Math.max(W, H) * 0.75);
    g.addColorStop(0, "rgb(0 0 0 / .55)"); g.addColorStop(0.45, "rgb(0 0 0 / .22)"); g.addColorStop(1, "rgb(0 0 0 / .1)");
    m.fillStyle = g; m.fillRect(0, 0, W, H);
    m.globalCompositeOperation = "destination-out";
    m.fillStyle = "rgb(0 0 0 / .14)";
    for (const [x, y, w, bh] of boxes) for (let p = 40; p >= 0; p -= 4) { m.beginPath(); m.roundRect(x - p, y - p, w + p * 2, bh + p * 2, 24 + p); m.fill(); }
    const lg = m.createRadialGradient(lx, ly, lr * 0.7, lx, ly, lr * 1.25);
    lg.addColorStop(0, "rgb(0 0 0 / .9)"); lg.addColorStop(1, "rgb(0 0 0 / 0)");
    m.fillStyle = lg; m.fillRect(0, 0, W, H);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    const cw = ctx.measureText("M").width, LH = SIZE * GAP;
    rows = []; spots = [];
    for (let y = LH / 2; y < H + LH; y += LH) {
      let s = "", w = 0;
      const starts: Row["starts"] = [];
      while (w < W * 2) { const p = phrase(); starts.push([w, p, ctx.measureText(p).width]); s += p + "    "; w = ctx.measureText(s).width; }
      rows.push({ y, s, w, starts, off: rand(0, w), v: (rows.length % 2 ? 1 : -1) * rand(0.8, 2.2) * cw });
    }
    draw();
  }

  const xOf = (r: Row, i: number) => (((i - r.off) % r.w) + r.w) % r.w;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = mid;
    for (const r of rows) {
      ctx.fillText(r.s, -r.off, r.y);
      if (r.w - r.off < W) ctx.fillText(r.s, r.w - r.off, r.y);
    }
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    for (const s of spots) {
      const x = xOf(s.r, s.i);
      if (x > W || hidden(x, s.r.y, s.pw)) continue;
      const chars = [...s.p], fade = 1 - smooth(2.4, 3.4, s.age);
      ctx.shadowColor = rgba(mid, 0.8 * fade); ctx.shadowBlur = GLOW;
      ctx.fillStyle = rgba(hi, fade);
      ctx.fillText(chars.slice(0, Math.ceil(s.age * TYPING)).join(""), x, s.r.y);
    }
    ctx.shadowBlur = 0;
  }

  // requestAnimationFrame already stops while the window is hidden or minimized.
  function frame(now: number) {
    now /= 1000;
    const dt = last ? Math.min(0.05, now - last) : 1 / 60;
    last = now;
    for (const r of rows) r.off = (r.off + r.v * dt + r.w) % r.w;
    if ((spotAt -= dt) <= 0) {
      spotAt = rand(0.5, 1.5) / RATE;
      // Highlights stay in the middle 66% so none flash at the very top or bottom (1251).
      const r = pick(rows.filter((r) => r.y > H * 0.17 && r.y < H * 0.83)), [i, p, pw] = pick(r.starts);
      spots.push({ r, i, p, pw, age: 0 });
    }
    spots = spots.filter((s) => (s.age += dt) < 3.4);
    draw();
    raf = requestAnimationFrame(frame);
  }

  let alive = true;
  const ro = new ResizeObserver(reset);
  document.fonts.load(FONT).finally(() => {
    if (!alive) return;
    reset();
    ro.observe(hero);
    darkQ.addEventListener("change", reset);
    if (!reduce) raf = requestAnimationFrame(frame);
  });

  // Holo logo tilt (home ticket 1028): a mouse or pen steers --mx/--my, at most once a frame.
  const card = logo.firstElementChild as HTMLElement;
  let ev: PointerEvent | null = null, tr = 0, t = 0;
  const clamp = (v: number) => Math.max(0, Math.min(1, v)).toFixed(3);
  const paint = () => {
    tr = 0;
    const b = logo.getBoundingClientRect();
    card.style.setProperty("--mx", clamp((ev!.clientX - b.left) / b.width));
    card.style.setProperty("--my", clamp((ev!.clientY - b.top) / b.height));
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    ev = e; clearTimeout(t);
    card.classList.remove("settle"); card.classList.add("on");
    if (!tr) tr = requestAnimationFrame(paint);
  };
  const leave = () => {
    if (!card.classList.contains("on")) return;
    cancelAnimationFrame(tr); tr = 0;
    card.classList.replace("on", "settle");
    card.style.removeProperty("--mx"); card.style.removeProperty("--my");
    t = window.setTimeout(() => card.classList.remove("settle"), 900);
  };
  if (!reduce) { logo.addEventListener("pointermove", move); logo.addEventListener("pointerleave", leave); }

  return () => {
    alive = false;
    cancelAnimationFrame(raf); cancelAnimationFrame(tr); clearTimeout(t);
    ro.disconnect();
    darkQ.removeEventListener("change", reset);
    logo.removeEventListener("pointermove", move); logo.removeEventListener("pointerleave", leave);
    canvas.remove();
  };
}
