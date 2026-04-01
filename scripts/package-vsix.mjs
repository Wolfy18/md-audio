import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const targetToPlatformKey = new Map([
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-unknown-linux-gnu", "linux-arm64"],
  ["x86_64-unknown-linux-gnu", "linux-x64"],
  ["aarch64-pc-windows-msvc", "win32-arm64"],
  ["x86_64-pc-windows-msvc", "win32-x64"],
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

const requestedTarget = process.env.MD_AUDIO_TARGET?.trim();
const platformKey = requestedTarget ? targetToPlatformKey.get(requestedTarget) : hostPlatformKey();

if (!platformKey) {
  throw new Error(
    `Unsupported MD_AUDIO_TARGET '${requestedTarget}'. Use one of: ${[...targetToPlatformKey.keys()].join(", ")}`,
  );
}

const nodeCommand = process.execPath;
const tscBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");
const vsceBin = path.join(repoRoot, "node_modules", ".bin", isWindows ? "vsce.cmd" : "vsce");

await run(nodeCommand, [path.join(repoRoot, "scripts", "build-native.mjs")]);
await run(tscBin, ["-p", path.join(repoRoot, "tsconfig.json")]);
await run(vsceBin, [
  "package",
  "--no-dependencies",
  "--allow-missing-repository",
  "--target",
  platformKey,
]);
