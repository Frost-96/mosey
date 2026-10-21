import { VitePlugin } from "@electron-forge/plugin-vite";
import path from "node:path";
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
    extraResource: [path.resolve("build/native")],
    extendInfo: {
      NSScreenCaptureUsageDescription:
        "Local Dock edge detection for pet climbing. Screen pixels stay in the native helper; no image files or uploads.",
    },
    osxSign: {
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: (filePath) => ({
        hardenedRuntime: false,
        timestamp: "none",
        ...(/\/native\/dock-(live|runtime)$/.test(filePath)
          ? {
              entitlements: [],
              additionalArguments: [
                "--identifier",
                filePath.endsWith("dock-runtime")
                  ? "dev.frost.mosey.dock-runtime"
                  : "dev.frost.mosey.dock-helper",
              ],
            }
          : {}),
      }),
    },
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
