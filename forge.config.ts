import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Vite bundles application code; this CommonJS logger stays external and
    // must travel inside the app rather than resolve from a developer checkout.
    ignore: (file) =>
      !!file &&
      file !== "/package.json" &&
      file !== "/.vite" &&
      !file.startsWith("/.vite/") &&
      file !== "/node_modules" &&
      file !== "/node_modules/electron-log" &&
      !file.startsWith("/node_modules/electron-log/"),
    appBundleId: "dev.frost.mosey",
    executableName: "Mosey",
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};
export default config;
