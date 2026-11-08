import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";
import path from "node:path";
import { atlasSchema, type Atlas } from "../src/shared/assets.ts";
import {
  characterPackageSchema,
  characterLoopTimings,
} from "../src/shared/characters.ts";
import {
  characterCapabilities,
  dailyActionDefinitions,
} from "../src/shared/character-capabilities.ts";
import baseline from "../tests/fixtures/corgi-daily-actions-baseline.json" with { type: "json" };

const dailyPoses = [
  "looking",
  "sittingdown",
  "sitting",
  "standingup",
  "yawning",
  "petted",
  "grooming",
  "celebrating",
  "habit",
] as const;
const readJSON = async (file: string) =>
  JSON.parse(await readFile(file, "utf8"));
const hash = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

async function atlases(id: string) {
  const directory =
    id === "corgi" ? "src/assets/generated" : `src/assets/generated/${id}`;
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith("-atlas.json"))
      .map(async (name) =>
        atlasSchema.parse(await readJSON(`${directory}/${name}`)),
      ),
  );
}

for (const id of ["whale", "claude", "gemini", "gpt"]) {
  test(`${id} exposes all daily poses with the adopted pixels, timing and contact`, async () => {
    const prepared = await atlases(id);
    assert.equal(prepared.length, 25);
    assert.doesNotThrow(() =>
      characterPackageSchema.parse({
        version: 1,
        id,
        name: id,
        atlases: prepared,
      }),
    );
    const capabilities = characterCapabilities(prepared.map((a) => a.action));
    assert.ok(
      dailyActionDefinitions.every((item) =>
        capabilities.includes(item.capability),
      ),
    );
    const root = `src/assets/characters/${id}`;
    const descriptor = await readJSON(`${root}/extensions.json`);
    const processing = descriptor.actions;
    for (const source of descriptor.sources)
      assert.equal(await hash(`${root}/${source.file}`), source.sha256);
    for (const action of dailyPoses) {
      const source = [...descriptor.sources]
        .reverse()
        .find((source) => source.actions.includes(action));
      assert.ok(source, `${id}/${action}: adoption provenance is missing`);
      const extensionRoot = path.dirname(`${root}/${source.file}`);
      const recorded = (await readJSON(`${root}/${source.file}`)).actions;
      const adopted = Array.isArray(recorded)
        ? recorded.find((item) => item.action === action)
        : recorded[action];
      assert.ok(adopted, `${id}/${action}: source description is missing`);
      const generated = prepared.find((a) => a.action === action)!;
      assert.ok(generated, `${id}/${action} was not prepared`);
      assert.equal(generated.loop, action === "sitting" ? "repeat" : "once");
      const expectedGeometry = adopted.frames.map(
        (f: Atlas["frames"][number]) => ({
          region: f.region,
          foot: f.foot,
          durationMs: f.durationMs,
        }),
      );
      assert.deepEqual(
        generated.frames.map(({ region, foot, durationMs }) => ({
          region,
          foot,
          durationMs,
        })),
        expectedGeometry,
      );
      assert.deepEqual(processing[action].frames, expectedGeometry);
      assert.equal(processing[action].sha256, adopted.sha256);
      assert.equal(
        await hash(`${root}/${processing[action].image}`),
        adopted.sha256,
      );
      const sourcePixels = await sharp(`${extensionRoot}/${adopted.image}`)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const output = await sharp(
        `src/assets/generated/${id}/${generated.image}`,
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.equal(sourcePixels.info.width, output.info.width);
      assert.equal(sourcePixels.info.height, output.info.height);
      for (let offset = 0; offset < sourcePixels.data.length; offset += 4) {
        assert.equal(
          output.data[offset + 3],
          sourcePixels.data[offset + 3],
          `${id}/${action}: alpha at ${offset}`,
        );
        if (sourcePixels.data[offset + 3])
          assert.ok(
            sourcePixels.data
              .subarray(offset, offset + 3)
              .equals(output.data.subarray(offset, offset + 3)),
            `${id}/${action}: visible RGB at ${offset}`,
          );
      }
    }
  });

  test(`${id} has the same neutral pixels at every seated and looking handoff`, async () => {
    const prepared = await atlases(id);
    const frame = async (action: Atlas["action"], index = 0) => {
      const atlas = prepared.find((a) => a.action === action)!;
      const value = atlas.frames.at(index)!;
      const r = value.region;
      const pixels = await sharp(`src/assets/generated/${id}/${atlas.image}`)
        .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
        .ensureAlpha()
        .raw()
        .toBuffer();
      for (let offset = 0; offset < pixels.length; offset += 4)
        if (pixels[offset + 3] === 0) pixels.fill(0, offset, offset + 3);
      return { pixels, foot: value.foot };
    };
    const standing = await frame("resting"),
      seated = await frame("sitting");
    for (const [action, index] of [
      ["looking", 0],
      ["looking", -1],
      ["sittingdown", 0],
      ["standingup", -1],
    ] as const)
      assert.deepEqual(
        await frame(action, index),
        standing,
        `${id}/${action} standing join`,
      );
    for (const [action, index] of [
      ["sitting", -1],
      ["sittingdown", -1],
      ["standingup", 0],
    ] as const)
      assert.deepEqual(
        await frame(action, index),
        seated,
        `${id}/${action} seated join`,
      );
    assert.ok(characterLoopTimings({ atlases: prepared })?.sitting);
  });
}

test("seated rest is optional, but every partial entry/loop/exit combination is rejected", async () => {
  const complete = await atlases("gpt");
  const seated = ["sittingdown", "sitting", "standingup"];
  const other = complete.filter((a) => !seated.includes(a.action));
  assert.doesNotThrow(() =>
    characterPackageSchema.parse({
      version: 1,
      id: "fixture",
      name: "fixture",
      atlases: other,
    }),
  );
  for (let mask = 1; mask < 7; mask++) {
    const partial = [
      ...other,
      ...complete.filter((a) => {
        const index = seated.indexOf(a.action);
        return index >= 0 && (mask & (1 << index)) !== 0;
      }),
    ];
    const result = characterPackageSchema.safeParse({
      version: 1,
      id: "fixture",
      name: "fixture",
      atlases: partial,
    });
    assert.equal(
      result.success,
      false,
      `Partial sitting group ${mask} was accepted`,
    );
    if (!result.success)
      assert.match(result.error.message, /Incomplete sitting/);
    assert.ok(
      !characterCapabilities(partial.map((a) => a.action)).includes("sitting"),
    );
  }
});

test("Corgi retains its original 43 asset files, 16 actions and capabilities", async () => {
  for (const [file, expected] of Object.entries(baseline.materialFiles))
    assert.equal(await hash(file), expected, `Corgi changed: ${file}`);
  const original = await atlases("corgi");
  assert.equal(characterLoopTimings({ atlases: original }), undefined);
  assert.deepEqual(
    original.map((a) => a.action).sort(),
    baseline.runtimeActions,
  );
  assert.deepEqual(
    characterCapabilities(original.map((a) => a.action)),
    baseline.capabilities,
  );
  assert.ok(
    dailyActionDefinitions.every(
      (item) =>
        !characterCapabilities(original.map((a) => a.action)).includes(
          item.capability,
        ),
    ),
  );
});
