"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { severityBadgeClass, severityLabel, SeverityDot } from "@/components/severity";
import { formatCameraLabel, formatRelativeTime } from "@/lib/utils";
import { mediaUrl, type Incident } from "@/lib/api";
import { ImageIcon, Video as VideoIcon } from "lucide-react";


function IncidentRow({ incident }: { incident: Incident }) {
  const cameraLabel = incident.fused
    ? (incident.cameras || []).map(formatCameraLabel).join(", ")
    : formatCameraLabel(incident.camera_id ?? "");

  return (
    <div className="flex gap-3 border-b border-border px-1 py-3.5 last:border-b-0">
      <SeverityDot severity={incident.severity} className="mt-1.5 h-2 w-2 shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{cameraLabel}</span>
            <Badge
              variant="outline"
              className={`h-5 border-transparent px-2 text-[10px] font-semibold ${severityBadgeClass(incident.severity)}`}
            >
              {severityLabel(incident.severity)}
            </Badge>
          </div>
          <span className="shrink-0 font-mono text-[11px] tracking-tight text-muted-foreground">
            {formatRelativeTime(incident.received_at)}
          </span>
        </div>

        <p className="mt-1 text-xs leading-relaxed text-foreground/80">{incident.summary}</p>

        {incident.entities?.some((e) => e.description) && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {incident.entities
              .filter((e) => e.description)
              .map((e, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground/70">{e.label[0].toUpperCase() + e.label.slice(1)}:</span>{" "}
                  {e.description}
                </li>
              ))}
          </ul>
        )}

        {incident.matches_rule === false && (
          <p className="mt-1.5 text-[11px] text-muted-foreground italic">
            Didn&apos;t match your alert rule
            {incident.rule_rationale ? ` — ${incident.rule_rationale}` : ""}
          </p>
        )}

        {(incident.photo_url || incident.video_url) && (
          <div className="mt-2 flex flex-col gap-2">
            {incident.photo_url && (
              <a
                href={mediaUrl(incident.photo_url)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-lg border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaUrl(incident.photo_url)}
                  alt="Incident snapshot"
                  className="max-h-40 w-full object-cover"
                />
              </a>
            )}
            <div className="flex flex-wrap gap-3">
              {incident.photo_url && (
                <a
                  href={mediaUrl(incident.photo_url)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <ImageIcon className="h-3.5 w-3.5" /> View photo
                </a>
              )}
              {incident.video_url && (
                <a
                  href={mediaUrl(incident.video_url)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <VideoIcon className="h-3.5 w-3.5" /> View clip
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function IncidentFeed({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) return
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Activity Log</h2>
      </div>

      <ScrollArea className="h-[460px] pr-3 [&::-webkit-scrollbar]:hidden">
        <div role="log" aria-live="polite" aria-relevant="additions" className="flex flex-col">
          {incidents.map((incident, idx) => (
            <div
              key={idx}
              className="animate-fade-up"
              style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}
            >
              <IncidentRow incident={incident} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

