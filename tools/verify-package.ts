import {
  identifyPackage,
  verifyPackageArtifact,
} from "./package-consumption.ts";
import { installedIdentity, sourceIdentity } from "./preparation-inputs.ts";

const root = process.cwd();
const identified = await identifyPackage(
  root,
  await sourceIdentity(root),
  await installedIdentity(root),
);
await verifyPackageArtifact(root, identified.appRoot, identified.manifest);
console.log(
  JSON.stringify({
    status: "verified",
    preparationId: identified.manifest.preparationId,
    manifestSHA256: identified.manifestSHA256,
    sourceId: identified.manifest.source.digest,
    producerId: identified.manifest.producer.digest,
    artifactSHA256: identified.manifest.artifact.digest,
  }),
);
