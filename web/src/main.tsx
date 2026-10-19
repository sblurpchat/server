import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import { boot } from "./store";

void boot();
// The on-screen keyboard covers the home bar, so the composer drops the safe-area gap while it is up (1310).
// Times scale, so a pinch zoom is not taken for a keyboard.
const vv = window.visualViewport;
vv?.addEventListener("resize", () => document.documentElement.toggleAttribute("data-keyboard", innerHeight - vv.height * vv.scale > 120));
if (import.meta.env.DEV) {
  document.body.insertAdjacentHTML("beforeend", '<div class="devline" aria-hidden="true"><span>development</span></div>');
}
createRoot(document.getElementById("root")!).render(<App />);
