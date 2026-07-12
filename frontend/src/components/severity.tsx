import type { Severity } from "@/lib/api";
import { cn } from "@/lib/utils";

const SEVERITY_STYLES: Record<Severity, string> = {
  low: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  unknown: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

/** Friendly, customer-facing labels shown instead of the raw severity enum. */
export const SEVERITY_LABELS: Record<Severity, string> = {
  low: "Low priority",
  medium: "Worth a look",
  high: "Needs attention",
  critical: "Urgent",
  unknown: "Unclassified",
};

export function severityBadgeClass(severity: Severity | undefined): string {
  return SEVERITY_STYLES[severity ?? "unknown"] ?? SEVERITY_STYLES.unknown;
}

export function severityLabel(severity: Severity | undefined): string {
  return SEVERITY_LABELS[severity ?? "unknown"] ?? SEVERITY_LABELS.unknown;
}


export function SeverityDot({ severity, className }: { severity: Severity | undefined; className?: string }) {
  const colorMap: Record<Severity, string> = {
    low: "bg-blue-500",
    medium: "bg-yellow-500",
    high: "bg-orange-500",
    critical: "bg-red-500",
    unknown: "bg-gray-400",
  };
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", colorMap[severity ?? "unknown"], className)}
    />
  );
}
