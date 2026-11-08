import fs from "node:fs/promises";
import console from "node:console";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
const dir = path.dirname(fileURLToPath(import.meta.url)),
  id = path.basename(path.resolve(dir, "../..")),
  hash = (b) => createHash("sha256").update(b).digest("hex");
async function asset(file) {
  const b = await fs.readFile(dir + "/" + file),
    m = await sharp(b).metadata();
  return { file, sha256: hash(b), width: m.width, height: m.height };
}
async function call(prompt, refs, output, status, notes, toolFile) {
  return {
    tool: "image_gen.imagegen",
    parameters: { transparent_background: true, referenced_image_paths: refs },
    prompt: {
      file: prompt,
      sha256: hash(await fs.readFile(dir + "/" + prompt)),
      text: await fs.readFile(dir + "/" + prompt, "utf8"),
    },
    inputs: await Promise.all(refs.map(asset)),
    output: await asset(output),
    status,
    notes,
    originalToolOutput: toolFile,
  };
}
const attempts =
  id === "claude"
    ? [
        await call(
          "prompt-seated.txt",
          ["references/standing.png", "references/half-crouch.png"],
          "generated/seated-attempt1.png",
          "accepted",
          "One new midpoint has crown66 between62/70, partial knee exposure and free hand between old side and knee poses. Reused unchanged for reversed rise.",
          "/Users/frost/.codex/generated_images/01a1b937-6a06-76d0-ba57-ed29272b222f/exec-cc755157-8f33-435d-ba3b-d5a0ab8a2c84.png",
        ),
        await call(
          "prompt-falling.txt",
          ["references/falling-end.png", "references/landing-first.png"],
          "generated/falling-attempt1.png",
          "accepted",
          "Four same-pitch forward-tilted poses; no upright reset. Last/first/old landing0 compared at480px. Entry also checked; old falling0..3 play once after the preserved flutter sequence to avoid an upright-to-prone entry jump.",
          "/Users/frost/.codex/generated_images/01a1b937-6a06-76d0-ba57-ed29272b222f/exec-a80482dd-62bc-4211-bb8e-00060511786b.png",
        ),
      ]
    : [
        await call(
          "prompt-seated.txt",
          ["references/standing.png", "references/next-crouch.png"],
          "generated/seated-attempt1.png",
          "rejected",
          "Two poses normalize to silhouette334px, narrower than original347 and continuation356. Second crown97 is below continuation95, creating reversal.",
          "/Users/frost/.codex/generated_images/01a1b937-6a06-76d0-ba57-ed29272b222f/exec-7ccac172-9595-43e9-a348-57fdf1c2f400.png",
        ),
        await call(
          "prompt-seated-attempt2.txt",
          ["references/standing.png"],
          "generated/seated-attempt2.png",
          "rejected-as-final-used-for-edit",
          "Skirt/short-leg/tail proportions improved, but hands moved too far inward before continuation and would reverse outward.",
          "/Users/frost/.codex/generated_images/01a1b937-6a06-76d0-ba57-ed29272b222f/exec-c8b886dd-ca26-4546-9707-b8103928736b.png",
        ),
        await call(
          "prompt-seated-attempt3.txt",
          [
            "generated/seated-attempt2.png",
            "references/standing.png",
            "references/next-crouch.png",
          ],
          "generated/seated-attempt3.png",
          "accepted",
          "Only arms corrected outward to early crouch phase. One pose replaces old1/2, preserving total140ms; crown87 between80/95, silhouette352 between347/356. Skirt remains original length while knees bend.",
          "/Users/frost/.codex/generated_images/01a1b937-6a06-76d0-ba57-ed29272b222f/exec-5bdb07ef-4d4b-4be9-ac80-d3a5c1902066.png",
        ),
      ];
const mappings =
  id === "claude"
    ? [
        ["standing", "sittingdown", 0],
        ["half-crouch", "sittingdown", 1],
        ["falling-end", "falling", 3],
        ["landing-first", "landing", 0],
      ]
    : [
        ["standing", "sittingdown", 0],
        ["old-first-crouch", "sittingdown", 2],
        ["next-crouch", "sittingdown", 3],
      ];
const references = [];
for (const [name, action, index] of mappings) {
  const a = JSON.parse(
    await fs.readFile(dir + `/originals/${action}.json`, "utf8"),
  );
  references.push({
    ...(await asset(`references/${name}.png`)),
    derivedFrom: {
      ...(await asset(`originals/${action}.png`)),
      frame: index,
      region: a.frames[index].region,
    },
    method:
      "Crop480px frame, clear alpha<128 and RGB in cleared pixels for clean generation reference. Archived original unchanged.",
  });
}
const manifest = JSON.parse(
  await fs.readFile(dir + "/replacements.json", "utf8"),
);
const record = {
  version: 1,
  character: id,
  purpose:
    "Minimal runtime continuity repair, preserving original neutral endpoints",
  pathResolution:
    "All relative paths are relative to this record. Original runtime atlases are archived in originals so adoption cannot invalidate hashes.",
  references,
  attempts,
  processing: {
    file: "processing-record.json",
    sha256: hash(await fs.readFile(dir + "/processing-record.json")),
    script: "prepare.mjs",
    scriptSha256: hash(await fs.readFile(dir + "/prepare.mjs")),
  },
  replacementManifest: {
    file: "replacements.json",
    sha256: hash(await fs.readFile(dir + "/replacements.json")),
  },
  outputs: await Promise.all(manifest.actions.map((a) => asset(a.image))),
  airborneEntryRepair: {
    originalFlutter: await asset("originals/flutter.png"),
    originalFalling: await asset("originals/falling.png"),
    method:
      "Original flutter0..11 copied pixel-identically. Original falling0..3 appended once as flutter12..15, with scale1 and whole-pose vertical translations41,35,39,41px. Alpha<128 cleared only on appended transition frames. Their visible bottom progresses430,438,446,454, then the new falling loop starts at462. No synthetic drawing, local compositing, or optical flow used for this transition.",
    appendedDurationsMs: [80, 70, 80, 90],
    reason:
      "Original flutter11 remains upright; direct transition to the new steady forward-tilted falling0 would relocate the former loop snap to the entry. Reusing the old four-pose turn as a once-only lead-in preserves the motion while removing its repeated reset.",
  },
  qa: {
    evidenceDirectory: `test-results/runtime-continuity-before/${id}`,
    inspected: [
      "v4-final-sittingdown.png",
      "v4-final-standingup.png",
      "v4-final-join.png",
      ...(id === "claude"
        ? [
            "v4-final-falling.png",
            "v4-final-flutter.png",
            "v4-fall-entry-options.png",
            "v4-fall-entry-final.png",
          ]
        : []),
    ],
    method:
      "Viewed generated sources, normalized endpoint strips and all final replacement frames. No desktop application started. No optical flow or head/body compositing.",
    originalPixelsPreserved:
      "All retained original seated and flutter0..11 frames are raw-copied; lossless WebP decoding equals RGBA at all alpha>0 pixels and exact alpha everywhere. Appended flutter12..15 preserve RGB/alpha>=128 pixels from the archived falling frames with only the explicitly recorded translation. Neutral anchors unmodified.",
    limits:
      "New generated drawings retain small line/rendering differences from old source frames; final desktop-speed review remains with root. No claim of pixel identity for new poses.",
  },
};
await fs.writeFile(
  dir + "/generation-record.json",
  JSON.stringify(record, null, 2) + "\n",
);
console.log(
  id,
  manifest.actions.map((a) => ({
    action: a.action,
    frames: a.frames.length,
    sha256: a.sha256,
  })),
);
