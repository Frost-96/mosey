import { test, expect } from "vitest";
import { createPetTestSession } from "../../tests/support/pet-session";

test.each(Array.from({ length: 50 }, (_, i) => i))(
  "[DEBUG-modal] hidden crash %s",
  async () => {
    const session = await createPetTestSession({
      dock: "empty",
      preferences: {
        version: 3,
        character: "corgi",
        size: 240,
        visibility: "visible",
      },
    });
    const { app, renderer } = await session.launch();
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Mosey")!
        .submenu!.items.find((item) => item.label === "Hide Mosey")!
        .click(),
    );
    session.mark("debug-crash");
    await renderer.crash();
    session.mark("debug-ready");
    expect((await renderer.waitUntilReady()).visible).toBe(false);
  },
  20000,
);
