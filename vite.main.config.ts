import { defineConfig } from "vite";
export default defineConfig({
  build: {
    rollupOptions: { external: ["electron", "electron-log/main"] },
    lib: { entry: "src/main.ts", formats: ["es"], fileName: () => "main.mjs" },
  },
});
