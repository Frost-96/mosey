import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import { expect, onTestFinished, test } from "vitest";
import { stagePackagePreparation } from "../tools/package-preparation";
import { preparationSourceFixture } from "./support/preparation-source-fixture";
import { measure } from "./support/measurement";

test("the genuine package producer includes public assets and compiled PostCSS from its captured inputs", async () => {
  const root = await preparationSourceFixture();
  await mkdir(path.join(root, "public"));
  await writeFile(
    path.join(root, "public/preparation-proof.txt"),
    "package-public-proof",
  );
  await writeFile(
    path.join(root, "postcss.config.mjs"),
    'export default { plugins: [{ postcssPlugin: "mosey-package-proof", Once(root) { root.append({ selector: ":root", nodes: [{ prop: "--mosey-package-proof", value: "packaged-input" }] }); } }] };',
  );
  const preparationId = randomUUID();
  const producer = await stagePackagePreparation(root, preparationId);
  onTestFinished(() => producer.close());
  await measure("package.prepare", { preparationId }, async () => {
    const child = spawn("pnpm", ["package:mac"], {
      cwd: producer.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const capture = (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-32768);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const terminate = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0 && !timedOut
          ? resolve()
          : reject(
              new Error(
                `Package fixture exited: ${code}/${signal}, timedOut=${timedOut}\n${output}`,
              ),
            ),
      );
    });
    onTestFinished(async () => {
      terminate();
      await Promise.allSettled([exited]);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 60000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  });
  const manifest = await producer.publish();
  const archive = path.join(
    root,
    "out/Mosey-darwin-arm64/Mosey.app/Contents/Resources/app.asar",
  );
  expect(
    extractFile(
      archive,
      ".vite/renderer/main_window/preparation-proof.txt",
    ).toString(),
  ).toBe("package-public-proof");
  const styles = listPackage(archive, { isPack: false })
    .filter(
      (file) =>
        file.startsWith("/.vite/renderer/main_window/") &&
        file.endsWith(".css"),
    )
    .map((file) => extractFile(archive, file.slice(1)).toString())
    .join("\n");
  expect(styles).toContain("--mosey-package-proof:packaged-input");
  expect(manifest.source.entries).toContain("public");
  expect(manifest.source.entries).toContain("postcss.config.mjs");
});
