import type { ElectronApplication } from "playwright";

// Both observations belong to the same main-process turn. The live system
// work area, rather than an earlier window position, defines the current floor.
export function distanceFromGround(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(
      (window) => window.getTitle() === "Mosey",
    )!;
    const bounds = pet.getBounds();
    const area = screen.getPrimaryDisplay().workArea;
    return bounds.y + bounds.height - area.y - area.height;
  });
}
