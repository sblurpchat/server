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
        // Over tailscale serve (https, ports 1xxxx) the board is on 18090 of the same host.
        { tag: "script", children: `{const s=document.createElement("script");s.async=true;s.onerror=()=>s.remove();s.src=location.hostname.endsWith(".ts.net")?"https://"+location.hostname+":18090/devnotes.js":"http://localhost:8090/devnotes.js";document.body.append(s)}`, injectTo: "body" },
      ],
    },
  ],
  server: { port: 5173, allowedHosts: [".ts.net"], fs: { allow: [".", "../auth/cmd/auth/static/downloads.json"] } }, // the shared download list (1325)
  test: { environment: "node", css: { include: [/app\.css/] } }, // logic.test reads the theme tokens
});
