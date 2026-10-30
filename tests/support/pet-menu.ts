import type { ElectronApplication } from "playwright";
import type { SessionOperation } from "./pet-session";

export function invokePetMenu(
  app: ElectronApplication,
  label: string,
  run: SessionOperation,
) {
  return run("pet-menu-input", () =>
    app.evaluate(async ({ Menu }, label) => {
      // Inspector input can interrupt a timer already selected for dispatch.
      // Run the real menu action on the main loop before acknowledging it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const item = Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === label);
      if (!item) throw new Error(`Missing menu: ${label}`);
      item.click();
    }, label),
  );
}
