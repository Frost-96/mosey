import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "playwright";
import {
  createPetTestSession,
  type PackagedPlatformOwnership,
  type SessionOperation,
} from "./pet-session";

const command = promisify(execFile);
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// mainAppService belongs to the running, signed macOS app. LaunchServices
// unregister alone does not disable that service. The common session owns all
// launches; this adapter restores through its existing app before shutdown.
export async function createLoginTestSession({
  signal,
}: { signal?: AbortSignal } = {}) {
  const identity = `dev.frost.mosey.login-test-${randomUUID()}`;
  let bundle: string | undefined;
  let evidence: string | undefined;
  let registrationAttempted = false;
  let registrationReleased = false;
  let serviceRestored = false;
  const record = (event: string, detail?: unknown) => {
    if (!evidence) return;
    // Diagnostic writes remain available after scenario cancellation.
    appendFileSync(
      evidence,
      JSON.stringify({ event, identity, bundle, detail }) + "\n",
    );
  };
  const read = async (
    app: ElectronApplication,
    run: SessionOperation,
    label = "login-system-read",
  ) => {
    const result = await run(label, () =>
      app.evaluate(({ app }) => ({
        system: app.getLoginItemSettings({ type: "mainAppService" }),
        appPath: app.getAppPath(),
        executable: process.execPath,
      })),
    );
    record(label, result);
    return result;
  };
  const platform: PackagedPlatformOwnership = {
    async prepare({ bundle: ownedBundle, evidence: directory, run, signal }) {
      bundle = ownedBundle;
      evidence = path.join(directory, "login-items.jsonl");
      record("identity-owned", {
        actualLogoutLogin: "Not performed by automation",
      });
      const nativeSignatures: Record<string, string> = {};
      for (const name of ["dock-runtime", "dock-live"]) {
        const before = await run(`login-${name}-signature-before`, () =>
          command(
            "/usr/bin/codesign",
            [
              "-d",
              "--verbose=4",
              path.join(ownedBundle, "Contents/Resources/native", name),
            ],
            { signal, timeout: 5000 },
          ),
        );
        nativeSignatures[name] = before.stderr;
      }
      await run("login-set-identity", () =>
        command(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            `Set :CFBundleIdentifier ${identity}`,
            path.join(ownedBundle, "Contents/Info.plist"),
          ],
          { signal, timeout: 5000 },
        ),
      );
      // Only the outer signature changes; the product and diagnostic native
      // signatures remain distinct. Never resign the shared prepared package.
      await run(
        "login-sign-identity",
        () =>
          command(
            "/usr/bin/codesign",
            ["--force", "--identifier", identity, "--sign", "-", ownedBundle],
            { signal, timeout: 30000 },
          ),
        { timeout: 30000 },
      );
      await run("login-verify-signature", () =>
        command(
          "/usr/bin/codesign",
          ["--verify", "--deep", "--strict", ownedBundle],
          { signal, timeout: 5000 },
        ),
      );
      const signature = await run("login-signature", () =>
        command("/usr/bin/codesign", ["-d", "--verbose=4", ownedBundle], {
          signal,
          timeout: 5000,
        }),
      );
      if (!signature.stderr.includes(`Identifier=${identity}\n`))
        throw new Error(
          "The login bundle's signing identity does not match its owned identity",
        );
      for (const [name, before] of Object.entries(nativeSignatures)) {
        const after = await run(`login-${name}-signature-after`, () =>
          command(
            "/usr/bin/codesign",
            [
              "-d",
              "--verbose=4",
              path.join(ownedBundle, "Contents/Resources/native", name),
            ],
            { signal, timeout: 5000 },
          ),
        );
        if (before !== after.stderr)
          throw new Error(`Login preparation changed the ${name} signature`);
      }
      record("signature-verified", {
        signature: signature.stderr,
        nativeSignatures,
      });
      // Arm compensation before the OS call: a rejected registration command
      // may already have registered the bundle before its response was lost.
      registrationAttempted = true;
      record("registration-armed");
      await run("login-register", () =>
        command(lsregister, ["-f", ownedBundle], { signal, timeout: 5000 }),
      );
      record("registered");
    },
    async restore({ app, attemptedLaunch, run }) {
      if (!registrationAttempted) return;
      if (!app) {
        if (attemptedLaunch && !serviceRestored)
          throw new Error(
            `Login service restoration unavailable; preserve ${bundle} (${identity}) for recovery`,
          );
        return;
      }
      await run("login-restore-disable", () =>
        app.evaluate(({ app }) =>
          app.setLoginItemSettings({
            type: "mainAppService",
            openAtLogin: false,
          }),
        ),
      );
      const restored = await read(app, run, "login-restored");
      if (
        restored.system.openAtLogin ||
        ["enabled", "requires-approval"].includes(restored.system.status)
      )
        throw new Error(
          `Owned login service is still registered: ${restored.system.status}`,
        );
      serviceRestored = true;
    },
    async release({ run }) {
      if (!registrationAttempted || registrationReleased) return;
      await run("login-unregister", () =>
        command(lsregister, ["-u", bundle!], { timeout: 5000 }),
      );
      registrationReleased = true;
      record("unregistered");
    },
  };
  const session = await createPetTestSession({
    dock: "real",
    signal,
    packagedPlatform: platform,
  });
  if (!bundle)
    throw new Error("The owned login bundle identity was not prepared");
  return {
    ...session,
    identity,
    bundle,
    readLogin: (app: ElectronApplication) => read(app, session.run),
  };
}
