import { VitePlugin } from "@electron-forge/plugin-vite";
import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: "dev.frost.mosey",
    executableName: "Mosey",
    extraResource: [path.resolve("build/native")],
    extendInfo: {
      NSScreenCaptureUsageDescription:
        "Optional bounded local Dock geometry validation. No pixel files or uploads.",
    },
    osxSign: {
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: (filePath) => ({
        hardenedRuntime: false,
        timestamp: "none",
        ...(filePath.endsWith("/native/dock-live")
          ? {
              entitlements: [],
              additionalArguments: [
                "--identifier",
                "dev.frost.mosey.dock-helper",
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
