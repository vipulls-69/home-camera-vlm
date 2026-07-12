import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Turns a raw camera id like "front_door-cam2" into "Front Door Cam2" so the
 * dashboard reads like a product, not a config file. */
export function formatCameraLabel(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Human-friendly relative time ("just now", "5m ago", "3h ago"), falling
 * back to a plain time-of-day once it's more than a day old. */
export function formatRelativeTime(epochSeconds?: number): string {
  if (!epochSeconds) return "";
  const diffSec = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(epochSeconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

