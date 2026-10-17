// Picking a per-community picture (1042): shrink big images in the browser
// first, like auth's avatar.js, so phone photos fit the 8 MB image limit.

/** How to redraw an image whose longer side is over max, or null to send it as is. */
export function shrinkPlan(w: number, h: number, type: string, max = 512): { w: number; h: number; type: string } | null {
  if (Math.max(w, h) <= max) return null; // as is keeps GIF animation and transparency
  const k = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), type: type === "image/jpeg" || type.startsWith("image/hei") ? "image/jpeg" : "image/png" };
}

/** The file to upload: shrunk when big, the original when small or not decodable. */
export async function shrinkImage(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const p = shrinkPlan(bmp.width, bmp.height, file.type);
    if (!p) return file;
    const c = document.createElement("canvas");
    c.width = p.w;
    c.height = p.h;
    c.getContext("2d")!.drawImage(bmp, 0, 0, p.w, p.h);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, p.type, 0.92));
    return blob ? new File([blob], p.type === "image/png" ? "avatar.png" : "avatar.jpg", { type: p.type }) : file;
  } catch {
    return file;
  }
}
