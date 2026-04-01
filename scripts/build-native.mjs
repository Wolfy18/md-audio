import { cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = path.join(repoRoot, "native");
const cargoHome = path.join(repoRoot, ".cargo-home");
const targetDir = path.join(nativeDir, "target");
const manifestPath = path.join(nativeDir, "Cargo.toml");

const targetToPlatformKey = new Map([
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-unknown-linux-gnu", "linux-arm64"],
  ["x86_64-unknown-linux-gnu", "linux-x64"],
  ["aarch64-pc-windows-msvc", "win32-arm64"],
  ["x86_64-pc-windows-msvc", "win32-x64"]
]);

function hostPlatformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "darwin-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "win32-arm64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }

  throw new Error(`Unsupported host platform: ${process.platform}-${process.arch}`);
}

function binaryNameFor(platformKey) {
  return platformKey.startsWith("win32-") ? "md-audio-native.exe" : "md-audio-native";
}

function runCargo(args) {
  return new Promise((resolve, reject) => {
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
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`cargo ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

const requestedTarget = process.env.MD_AUDIO_TARGET?.trim();
const platformKey = requestedTarget ? targetToPlatformKey.get(requestedTarget) : hostPlatformKey();

if (!platformKey) {
  throw new Error(
    `Unsupported target triple "${requestedTarget}". Set MD_AUDIO_TARGET to a known build target.`,
  );
}

const cargoArgs = ["build", "--release", "--manifest-path", manifestPath];

if (requestedTarget) {
  cargoArgs.push("--target", requestedTarget);
}

await runCargo(cargoArgs);

const binaryName = binaryNameFor(platformKey);
const builtBinary = requestedTarget
  ? path.join(targetDir, requestedTarget, "release", binaryName)
  : path.join(targetDir, "release", binaryName);
const destinationDir = path.join(repoRoot, "dist", "native", platformKey);
const destinationBinary = path.join(destinationDir, binaryName);

await mkdir(destinationDir, { recursive: true });
await cp(builtBinary, destinationBinary, { force: true });

console.log(`Built native binary for ${platformKey} at ${destinationBinary}`);

