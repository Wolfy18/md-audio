import path from "node:path";

export function resolvePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "darwin-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "linux-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "linux-x64";
  }
  if (platform === "win32" && arch === "arm64") {
    return "win32-arm64";
  }
  if (platform === "win32" && arch === "x64") {
    return "win32-x64";
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export function nativeBinaryName(platformKey: string): string {
  return platformKey.startsWith("win32-") ? "md-audio-native.exe" : "md-audio-native";
}

export function resolveNativeBinaryPath(extensionPath: string): string {
  const platformKey = resolvePlatformKey();
  return path.join(extensionPath, "dist", "native", platformKey, nativeBinaryName(platformKey));
}

