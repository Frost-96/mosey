import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from "electron";
import path from "node:path";
// Retain the native tray for the entire application lifetime.
let tray: Tray | undefined;
app.on("will-quit", () => tray?.destroy());
void app.whenReady().then(async () => {
  const quit = () => app.quit();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Mosey",
        submenu: [
          {
            label: "Quit Mosey",
            accelerator: "CommandOrControl+Q",
            click: quit,
          },
        ],
      },
    ]),
  );
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  );
  tray = new Tray(icon);
  tray.setTitle("🐾");
  tray.setToolTip("Mosey");
  tray.setContextMenu(
    Menu.buildFromTemplate([{ label: "Quit Mosey", click: quit }]),
  );
  const area = screen.getPrimaryDisplay().workArea;
  const pet = new BrowserWindow({
    width: 240,
    height: 240,
    x: area.x + Math.round((area.width - 240) / 2),
    y: area.y + area.height - 240,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pet.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pet.webContents.on("will-navigate", (event) => event.preventDefault());
  pet.once("ready-to-show", () => pet.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    await pet.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    await pet.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  app.on("window-all-closed", quit);
});
