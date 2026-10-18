import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";
import { boot } from "./store";

void boot();
if (import.meta.env.DEV) {
  document.body.insertAdjacentHTML("beforeend", '<div class="devline" aria-hidden="true"><span>development</span></div>');
}
createRoot(document.getElementById("root")!).render(<App />);
