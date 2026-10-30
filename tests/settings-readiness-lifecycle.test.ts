import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { openSettings } from "./support/settings";
import { createPetTestSession } from "./support/pet-session";

test("opening settings tolerates delayed renderer controls within its readiness deadline", async () => {
  const session = await createPetTestSession({
    dock: "empty",
    preferences: { version: 1, size: "large", visibility: "hidden" },
  });
  const { app } = await session.launch();
  const trace = path.join(session.evidence, "settings-script-delay.jsonl");
  await session.run("settings-readiness:delay-renderer-script", () =>
    app.evaluate(({ session }, trace) => {
      let delayed = false;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (
          delayed ||
          details.resourceType !== "script" ||
          !new URL(details.url).pathname.includes("/settings")
        ) {
          callback({ cancel: false });
          return;
        }
        delayed = true;
        const record = (event: string) =>
          process.getBuiltinModule("node:fs").appendFileSync(
            trace,
            JSON.stringify({
              event,
              at: performance.now(),
              url: details.url,
            }) + "\n",
          );
        record("held");
        // Delay one real module response after the settings document exists.
        // This is below the existing 15s readiness budget, above the old 1s probe.
        setTimeout(() => {
          record("released");
          callback({ cancel: false });
        }, 2000);
      });
    }, trace),
  );
  const settings = await openSettings(app, { run: session.run });
  expect(
    await session.run("settings-readiness:delayed-character", () =>
      settings.getByRole("combobox", { name: "角色" }).inputValue(),
    ),
  ).toBe("whale");
  expect(
    await session.run("settings-readiness:delayed-size", () =>
      settings.locator("output").textContent(),
    ),
  ).toBe("240");
  expect(
    await session.run("settings-readiness:delayed-native-visibility", () =>
      app.evaluate(({ BrowserWindow }) => ({
        settings: BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey 设置")!
          .isVisible(),
        pet: BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Mosey")!
          .isVisible(),
      })),
    ),
  ).toEqual({ settings: true, pet: false });
  const events = await session.run("settings-readiness:delay-evidence", () =>
    readFile(trace, "utf8"),
  );
  expect(events).toContain('"event":"held"');
  expect(events).toContain('"event":"released"');
  await session.quit();
});
