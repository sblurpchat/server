// Picking a per-community picture (1042): shrink big images in the browser
// first, like auth's avatar.js, so phone photos fit the 8 MB image limit.

/** How to redraw an image whose longer side is over max, or null to send it as is. */
export function shrinkPlan(w: number, h: number, type: string, max = 512): { w: number; h: number; type: string } | null {
  if (Math.max(w, h) <= max) return null; // as is keeps GIF animation and transparency
  const k = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), type: type === "image/jpeg" || type.startsWith("image/hei") ? "image/jpeg" : "image/png" };
}

/** Draws the [sx, sy, sw, sh] part of `src` at w × h and encodes it; null when the browser can't. */
export function drawBlob(src: CanvasImageSource, [sx, sy, sw, sh]: number[], w: number, h: number, type: string, quality: number): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return new Promise((r) => c.toBlob(r, type, quality));
}

/** The file to upload: shrunk when big, the original when small or not decodable. */
export async function shrinkImage(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const p = shrinkPlan(bmp.width, bmp.height, file.type);
    if (!p) return file;
    const blob = await drawBlob(bmp, [0, 0, bmp.width, bmp.height], p.w, p.h, p.type, 0.92);
    return blob ? new File([blob], p.type === "image/png" ? "avatar.png" : "avatar.jpg", { type: p.type }) : file;
  } catch {
    return file;
  }
}

/** A JPEG still from near 0.1 s of a video, so viewers load no video bytes until they play it
 * (1324). Null when the browser cannot draw one within 3 s; the upload then goes on without it. */
export function videoPoster(file: File): Promise<File | null> {
  const capture = async () => {
    const v = document.createElement("video");
    const src = URL.createObjectURL(file);
    const next = (ev: string) => new Promise((ok, no) => (v.addEventListener(ev, ok, { once: true }), v.addEventListener("error", no, { once: true })));
    try {
      v.muted = true;
      v.playsInline = true;
      const loaded = next("loadeddata");
      v.src = src;
      await loaded;
      const seeked = next("seeked");
      v.currentTime = Math.min(0.1, v.duration / 2 || 0); // 0.1 s, so not a black fade-in frame
      await seeked;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return null;
      const p = shrinkPlan(w, h, "image/jpeg", 960) ?? { w, h };
      const blob = await drawBlob(v, [0, 0, w, h], p.w, p.h, "image/jpeg", 0.8);
      return blob && blob.size <= 500 << 10 ? new File([blob], "poster.jpg", { type: "image/jpeg" }) : null; // server cap 512 KB
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(src);
    }
  };
  return Promise.race([capture(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
}
