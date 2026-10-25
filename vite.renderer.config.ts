import { defineConfig } from "vite";
// Keep media-gated settings CSS external: data: styles are forbidden by CSP.
export default defineConfig({ base: "./", build: { assetsInlineLimit: 0 } });
