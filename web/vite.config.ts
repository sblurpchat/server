import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      // Dev-only sticky-note overlay from tools/tickets. A missing script fails silently.
      name: "devnotes",
      apply: "serve",
      transformIndexHtml: () => [
        { tag: "script", attrs: { src: "http://localhost:8090/devnotes.js", async: true, onerror: "this.remove()" }, injectTo: "body" },
      ],
    },
  ],
  server: { port: 5173 },
  test: { environment: "node" },
});
