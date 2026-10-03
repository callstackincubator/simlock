import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The web console's build (ADR 0011 §1, §2, §7). Run with `ui` as Vite's root (`vite build ui`),
 * so every path below is relative to this directory.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    // `dist/ui`, beside the daemon's own build: the package already publishes `dist`.
    outDir: "../dist/ui",
    emptyOutDir: true,
    // No font or image becomes a `data:` URI: the CSP allows fonts and images from `'self'` only.
    assetsInlineLimit: 0,
    // Nothing to polyfill in the browsers the console supports, and nothing inline either.
    modulePreload: { polyfill: false },
    // One bundle, charts included, loaded from the daemon itself: its size matters little.
    chunkSizeWarningLimit: 1_000,
  },
  server: {
    // Development only: a local daemon with `http.enabled` answers `/v1` on its default port.
    proxy: { "/v1": "http://127.0.0.1:4700" },
  },
});
