import { expect } from "vitest";
import type { ElectronApplication, Page } from "playwright";
export async function openSettings(
  app: ElectronApplication,
  { waitForInitialState = true }: { waitForInitialState?: boolean } = {},
) {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!
      .items.find((item) => item.label === "Mosey")!
      .submenu!.items.find((item) => item.label === "设置…")!
      .click();
  });
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
          await candidate
            .getByRole("button", { name: "中（默认）" })
            .waitFor({ timeout: 1000 });
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
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === "Mosey 设置",
          );
          return !!window?.isVisible();
        }),
      { timeout: 15000 },
    )
    .toBe(true);
  // React can paint controls before the first settings snapshot arrives. Most
  // callers need confirmed settings; ordering tests explicitly inspect loading.
  if (waitForInitialState)
    await page!
      .getByText("正在读取系统状态…", { exact: true })
      .waitFor({ state: "hidden", timeout: 15000 });
  return page!;
}
export async function closeSettings(app: ElectronApplication) {
  const page = app
    .windows()
    .find(
      (window) =>
        !window.isClosed() &&
        new URL(window.url()).searchParams.has("settings"),
    );
  // Electron's native close completes before Playwright receives Page.close.
  // Subscribe first and await both boundaries before a later reopen.
  const closed = page?.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === "Mosey 设置")
      ?.close();
  });
  await closed;
}

export async function chooseSize(app: ElectronApplication, label: string) {
  const page = await openSettings(app);
  const before = await app.evaluate(({ BrowserWindow }) => {
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
  });
  await page
    .getByRole("button", {
      name: (
        { Small: "小", Medium: "中（默认）", Large: "大" } as Record<
          string,
          string
        >
      )[label]!,
      exact: true,
    })
    .click();
  const after = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "Mosey")!
      .getBounds(),
  );
  const observation = (await app.evaluate(() => {
    const result = Reflect.get(globalThis, "resizeObservation") as
      { before: typeof before; after: typeof after; at: number } | undefined;
    Reflect.get(globalThis, "restoreResizeObservation")();
    return result;
  })) ?? { before, after, at: await app.evaluate(() => performance.now()) };
  // Pet acceptance scenarios finish their setup here. Settings interaction is
  // exercised separately; keep its focused controls out of subsequent input.
  await closeSettings(app);
  return observation;
}
