import type { ComponentType } from "react";
import { House, Store, Warehouse, Building2 } from "lucide-react";
import type { DetectionConfig } from "@/lib/api";

export interface DetectionTemplate {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  values: Partial<DetectionConfig>;
}

/** Deployment presets for the Detection Tuning tab - each bundles a set of
 * sensible defaults for a common camera placement, so people don't have to
 * understand every tunable to get a good starting point. Values can still be
 * fine-tuned individually afterwards. Shared between the global Detection
 * Tuning tab and the per-camera override picker. */
export const DETECTION_TEMPLATES: DetectionTemplate[] = [
  {
    label: "Home",
    description: "Quiet residential scenes - sensitive to motion, longer cooldowns so a lingering visitor is one incident.",
    icon: House,
    values: {
      motion_threshold: 2.5,
      confidence_threshold: 0.7,
      min_detection_area_ratio: 0.0,
      track_cooldown_sec: 60,
      spatial_dedup_iou_threshold: 0.3,
      event_diff_threshold: 80,
      vlm_dispatch_cooldown_sec: 3,
      fusion_correlation_window_sec: 8,
    },
  },
  {
    label: "Shop / Retail",
    description: "Busy foot traffic - less sensitive to constant motion, shorter cooldowns so each new customer still gets noticed.",
    icon: Store,
    values: {
      motion_threshold: 4,
      confidence_threshold: 0.65,
      min_detection_area_ratio: 0.01,
      track_cooldown_sec: 20,
      spatial_dedup_iou_threshold: 0.4,
      event_diff_threshold: 60,
      vlm_dispatch_cooldown_sec: 2,
      fusion_correlation_window_sec: 5,
    },
  },
  {
    label: "Warehouse / Outdoor",
    description: "Large open areas with distant activity - ignores far-away/small subjects and tolerates more background motion (wind, shadows).",
    icon: Warehouse,
    values: {
      motion_threshold: 6,
      confidence_threshold: 0.75,
      min_detection_area_ratio: 0.03,
      track_cooldown_sec: 90,
      spatial_dedup_iou_threshold: 0.25,
      event_diff_threshold: 85,
      vlm_dispatch_cooldown_sec: 4,
      fusion_correlation_window_sec: 12,
    },
  },
  {
    label: "Office",
    description: "Indoor workspace with regular foot traffic during the day - balanced sensitivity, moderate cooldowns.",
    icon: Building2,
    values: {
      motion_threshold: 3,
      confidence_threshold: 0.7,
      min_detection_area_ratio: 0.0,
      track_cooldown_sec: 45,
      spatial_dedup_iou_threshold: 0.3,
      event_diff_threshold: 70,
      vlm_dispatch_cooldown_sec: 3,
      fusion_correlation_window_sec: 8,
    },
  },
];
