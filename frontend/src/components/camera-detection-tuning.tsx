"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type CameraDetectionConfig, type DetectionConfig, type Severity } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DETECTION_TEMPLATES } from "@/lib/detection-templates";

const SEVERITY_COPY: Partial<Record<Severity, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** Finds the name of a built-in or custom template whose values exactly
 * match a camera's current overrides, so the "Attach a template..." picker
 * reflects a previously-applied template instead of resetting to blank
 * every time this panel remounts (e.g. after navigating away and back). */
function matchingTemplateName(
  overrides: Partial<DetectionConfig>,
  customTemplates: Record<string, Partial<DetectionConfig>>
): string {
  const overrideEntries = Object.entries(overrides);
  if (overrideEntries.length === 0) return "";
  const candidates: { name: string; values: Partial<DetectionConfig> }[] = [
    ...DETECTION_TEMPLATES.map((t) => ({ name: t.label, values: t.values })),
    ...Object.entries(customTemplates).map(([name, values]) => ({ name, values })),
  ];
  const match = candidates.find(({ values }) => {
    const entries = Object.entries(values);
    if (entries.length !== overrideEntries.length) return false;
    return entries.every(([key, value]) => (overrides as Record<string, unknown>)[key] === value);
  });
  return match?.name ?? "";
}

/** Per-camera Detection Tuning + severity controls, shown under each
 * camera's rule card so a specific camera (e.g. a cash register or a quiet
 * back office) can run hotter/cooler or always be treated as a fixed
 * severity, without affecting every other camera. */
export function CameraDetectionTuning({
  cameraId,
  customTemplates,
}: {
  cameraId: string;
  customTemplates: Record<string, Partial<DetectionConfig>>;
}) {
  const [data, setData] = useState<CameraDetectionConfig | null>(null);
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [severityLevels, setSeverityLevels] = useState<Severity[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [detectionRes, severityRes] = await Promise.all([
          api.getCameraDetectionConfig(cameraId),
          api.getCameraSeverityOverride(cameraId),
        ]);
        if (cancelled) return;
        setData(detectionRes);
        setSeverity(severityRes.severity);
        setSeverityLevels(severityRes.severity_levels);
        setSelectedTemplate(matchingTemplateName(detectionRes.overrides, customTemplates));
      } catch (err) {
        toast.error(`Failed to load detection settings for "${cameraId}": ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  const overrideCount = data ? Object.keys(data.overrides).length : 0;

  const allTemplates: { name: string; values: Partial<DetectionConfig> }[] = [
    ...DETECTION_TEMPLATES.map((t) => ({ name: t.label, values: t.values })),
    ...Object.entries(customTemplates).map(([name, values]) => ({ name, values })),
  ];

  const handleApplyTemplate = async () => {
    const tpl = allTemplates.find((t) => t.name === selectedTemplate);
    if (!tpl) {
      toast.error("Choose a template first.");
      return;
    }
    setApplying(true);
    try {
      const res = await api.updateCameraDetectionConfig(cameraId, tpl.values);
      setData(res);
      toast.success(`Applied "${tpl.name}" to "${cameraId}".`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const handleResetOverrides = async () => {
    setApplying(true);
    try {
      const res = await api.clearCameraDetectionConfig(cameraId);
      setData(res);
      setSelectedTemplate("");
      toast.success(`"${cameraId}" reverted to global detection defaults.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const handleSeverityChange = async (value: string) => {
    const next = value === "auto" ? null : (value as Severity);
    setSeverity(next);
    try {
      await api.updateCameraSeverityOverride(cameraId, next);
      toast.success(
        next
          ? `"${cameraId}" incidents will always be marked ${SEVERITY_COPY[next] ?? next}.`
          : `"${cameraId}" now uses the AI's own severity assessment.`
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground">Detection Tuning for this camera</Label>
        {overrideCount > 0 && (
          <Badge variant="secondary" className="shrink-0">
            {overrideCount} custom setting{overrideCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Attach a template..." />
          </SelectTrigger>
          <SelectContent>
            {allTemplates.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={handleApplyTemplate} disabled={applying || !selectedTemplate}>
          Apply to {cameraId}
        </Button>
        {overrideCount > 0 && (
          <Button size="sm" variant="ghost" onClick={handleResetOverrides} disabled={applying}>
            Reset to global defaults
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Alert Severity</Label>
        <Select value={severity ?? "auto"} onValueChange={handleSeverityChange}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Use the AI&apos;s own assessment</SelectItem>
            {severityLevels.map((level) => (
              <SelectItem key={level} value={level}>
                Always mark as {SEVERITY_COPY[level] ?? level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Overrides the AI&apos;s severity call for every incident on this camera - e.g. treat any event here as
          Critical.
        </p>
      </div>
    </div>
  );
}
