import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = path.join(repoRoot, "native");
const cargoHome = path.join(repoRoot, ".cargo-home");
const targetDir = path.join(nativeDir, "target");
const manifestPath = path.join(nativeDir, "Cargo.toml");

const args = ["test", "--manifest-path", manifestPath];

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn("cargo", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: targetDir
    },
    stdio: "inherit"
  });

  child.on("error", reject);
  child.on("exit", (code) => resolve(code ?? 1));
});

if (exitCode !== 0) {
  process.exit(exitCode);
}
