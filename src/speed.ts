export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const DEFAULT_SPEED = 1;

export const SPEED_PRESETS = [0.75, 0.9, 1, 1.1, 1.25] as const;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) {
    return DEFAULT_SPEED;
  }

  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

export function formatSpeed(speed: number): string {
  const rounded = Math.round(clampSpeed(speed) * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `${text}x`;
}
