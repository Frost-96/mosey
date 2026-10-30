import { expect } from "vitest";
import type { SessionOperation } from "./pet-session";
import type { ElectronApplication, Page } from "playwright";
export async function openSettings(
  app: ElectronApplication,
  {
    waitForInitialState = true,
    run = (_label, action) => action(),
  }: { waitForInitialState?: boolean; run?: SessionOperation } = {},
) {
  await run("settings-open", () =>
    app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "设置…")!
        .click();
    }),
  );
  let page: Page | undefined;
  await expect
    .poll(
      async () => {
        const candidate = app
          .windows()
          .find(
            (window) =>
              !window.isClosed() &&
              new URL(window.url()).searchParams.has("settings"),
          );
        if (!candidate) return false;
        try {
          // A pending DOM is an observation, not a failed session operation.
          // Keep the existing readiness budget while guarding each driver call.
          const visible = await run("settings-controls", () =>
            candidate.getByRole("button", { name: "中（默认）" }).isVisible(),
          );
          if (!visible) return false;
        } catch (error) {
          if (candidate.isClosed()) return false;
          throw error;
        }
        page = candidate;
        return !candidate.isClosed();
      },
      { timeout: 15000 },
    )
    .toBe(true);
  // DOM readiness precedes ready-to-show. CDP input needs the visible fixture;
  // native OS focus belongs to separate desktop acceptance.
  await expect
    .poll(
      () =>
        run("settings-visible", () =>
          app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows().find(
              (window) => window.getTitle() === "Mosey 设置",
            );
            return !!window?.isVisible();
          }),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  // React can paint controls before the first settings snapshot arrives. Most
  // callers need confirmed settings; ordering tests explicitly inspect loading.
  if (waitForInitialState)
    await run(
      "settings-initial-state",
      () =>
        page!
          .getByText("正在读取系统状态…", { exact: true })
          .waitFor({ state: "hidden", timeout: 15000 }),
      { timeout: 15000 },
    );
  return page!;
}
export async function closeSettings(
  app: ElectronApplication,
  { run = (_label, action) => action() }: { run?: SessionOperation } = {},
) {
  const page = app
    .windows()
    .find(
      (window) =>
        !window.isClosed() &&
        new URL(window.url()).searchParams.has("settings"),
    );
  // Electron's native close completes before Playwright receives Page.close.
  // Subscribe first and await both boundaries before a later reopen.
  const closed = page
    ? run("settings-page-close", () => page.waitForEvent("close"))
    : Promise.resolve();
  // Keep the early event subscription observed even if native close fails.
  void closed.catch(() => {});
  await run("settings-native-close", () =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Mosey 设置")
        ?.close();
    }),
  );
  await closed;
}

export async function chooseSize(
  app: ElectronApplication,
  label: string,
  { run = (_label, action) => action() }: { run?: SessionOperation } = {},
) {
  const page = await openSettings(app, { run });
  const before = await run("size-observe-resize", () =>
    app.evaluate(({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === "Mosey",
      )!;
      Reflect.set(globalThis, "resizeObservation", undefined);
      const original = pet.setBounds.bind(pet);
      Reflect.set(globalThis, "restoreResizeObservation", () => {
        pet.setBounds = original;
      });
      pet.setBounds = (bounds, animate) => {
        const before = pet.getBounds();
        original(bounds, animate);
        if (bounds.width !== undefined && bounds.width !== before.width)
          Reflect.set(globalThis, "resizeObservation", {
            before,
            after: pet.getBounds(),
            at: performance.now(),
          });
      };
      return pet.getBounds();
    }),
  );
  await run("size-preset-click", () =>
    page
      .getByRole("button", {
        name: (
          { Small: "小", Medium: "中（默认）", Large: "大" } as Record<
            string,
            string
          >
        )[label]!,
        exact: true,
      })
      .click(),
  );
  const after = await run("size-native-bounds", () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Mosey")!
        .getBounds(),
    ),
  );
  const observation = (await run("size-finish-observation", () =>
    app.evaluate(() => {
      const result = Reflect.get(globalThis, "resizeObservation") as
        { before: typeof before; after: typeof after; at: number } | undefined;
      Reflect.get(globalThis, "restoreResizeObservation")();
      return result;
    }),
  )) ?? {
    before,
    after,
    at: await run("size-native-bounds", () =>
      app.evaluate(() => performance.now()),
    ),
  };
  // Pet acceptance scenarios finish their setup here. Settings interaction is
  // exercised separately; keep its focused controls out of subsequent input.
  await closeSettings(app, { run });
  return observation;
}
