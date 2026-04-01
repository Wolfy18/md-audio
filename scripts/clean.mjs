import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all([
  rm(path.join(repoRoot, "dist"), { force: true, recursive: true }),
  rm(path.join(repoRoot, ".cargo-home"), { force: true, recursive: true })
]);

