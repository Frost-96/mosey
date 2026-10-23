import { expect } from "vitest";
import type { ElectronApplication } from "playwright";
export async function openSettings(app: ElectronApplication) {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!
      .items.find((item) => item.label === "Mosey")!
      .submenu!.items.find((item) => item.label === "设置…")!
      .click();
  });
  await expect
    .poll(() =>
      app
        .windows()
        .find((page) => new URL(page.url()).searchParams.has("settings")),
    )
    .toBeTruthy();
  const page = app
    .windows()
    .find((page) => new URL(page.url()).searchParams.has("settings"))!;
  await page.getByRole("button", { name: "中（默认）" }).waitFor();
  return page;
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
  return (
    (await app.evaluate(() => {
      const result = Reflect.get(globalThis, "resizeObservation") as
        { before: typeof before; after: typeof after } | undefined;
      Reflect.get(globalThis, "restoreResizeObservation")();
      return result;
    })) ?? { before, after }
  );
}
