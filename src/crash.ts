import { crashAlertPatterns } from "./config.js";

export function isCrashSignal(...parts: Array<unknown>) {
  const text = parts
    .map((p) => String(p || "").toLowerCase())
    .join(" ");
  return crashAlertPatterns.some((pattern) => pattern && text.includes(pattern));
}
