import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import { boot } from "./store";

void boot();
// The on-screen keyboard covers the home bar, so the composer drops the safe-area gap while it is up (1310).
// Times scale, so a pinch zoom is not taken for a keyboard.
const vv = window.visualViewport;
// --kb is how much of the layout bottom the keyboard hides, so a bottom sheet can sit above it (1415).
const onVV = () => {
  const root = document.documentElement;
  root.toggleAttribute("data-keyboard", innerHeight - vv!.height * vv!.scale > 120);
  root.style.setProperty("--kb", `${vv!.scale > 1 ? 0 : Math.max(0, innerHeight - vv!.height - vv!.offsetTop)}px`);
};
vv?.addEventListener("resize", onVV);
vv?.addEventListener("scroll", onVV);
if (import.meta.env.DEV) {
  document.body.insertAdjacentHTML("beforeend", '<div class="devline" aria-hidden="true"><span>development</span></div>');
}
createRoot(document.getElementById("root")!).render(<App />);
