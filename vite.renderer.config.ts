import { defineConfig } from "vite";
// Keep media-gated settings CSS external: data: styles are forbidden by CSP.
export default defineConfig({
  base: "./",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
  build: { assetsInlineLimit: 0 },
});
