import { defineConfig, type Plugin } from "vite";

// Forge asks the renderer server for a full reload after every preload build,
// including the first one, before any document exists. Vite buffers a reload
// sent with no connected client and delivers it to the next client, so the
// first freshly loaded pet document would reload itself ~20ms after loading.
// A reload with no connected document has nothing stale to replace: drop it.
const dropReloadWithoutClients: Plugin = {
  name: "mosey:drop-reload-without-clients",
  apply: "serve",
  configureServer(server) {
    const send = server.ws.send.bind(server.ws) as (...args: unknown[]) => void;
    server.ws.send = ((...args: unknown[]) => {
      const payload = args[0];
      if (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === "full-reload" &&
        server.ws.clients.size === 0
      )
        return;
      send(...args);
    }) as typeof server.ws.send;
  },
};

// Keep media-gated settings CSS external: data: styles are forbidden by CSP.
export default defineConfig({
  base: "./",
  plugins: [dropReloadWithoutClients],
  // The project root also holds packaged apps and build outputs. Crawl only the
  // real entry (not e.g. a 20 MB out/…/LICENSES.chromium.html), and do not
  // watch thousands of packaged or generated files no renderer module imports.
  server: {
    watch: { ignored: ["**/out/**", "**/build/**", "**/release/**"] },
  },
  optimizeDeps: {
    entries: ["index.html"],
    include: ["react", "react-dom/client", "react/jsx-runtime"],
  },
  build: { assetsInlineLimit: 0 },
});
