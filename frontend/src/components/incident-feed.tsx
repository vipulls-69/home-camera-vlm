"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { severityLabel, SeverityDot } from "@/components/severity";
import { formatCameraLabel, formatRelativeTime } from "@/lib/utils";
import { mediaUrl, type Incident } from "@/lib/api";
import { CheckCircle2, ImageIcon, Video as VideoIcon } from "lucide-react";

export function IncidentFeed({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) {
    return (
      <div className="animate-fade-up flex flex-col items-center gap-2 py-10 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-950/40">
          <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-foreground">Nothing to report yet</p>
        <p className="max-w-[220px] text-xs text-muted-foreground">
          We&apos;ll let you know here the moment your cameras notice anything worth a look.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[520px] pr-3  [&::-webkit-scrollbar]:hidden">
      <div role="log" aria-live="polite" aria-relevant="additions">
        {incidents.map((incident, idx) => {
          const cameraLabel = incident.fused
            ? (incident.cameras || []).map(formatCameraLabel).join(", ")
            : formatCameraLabel(incident.camera_id ?? "");
          const isLast = idx === incidents.length - 1;
          return (
            <div
              key={idx}
              className="animate-fade-up relative flex gap-3 pb-5"
              style={{ animationDelay: `${Math.min(idx, 8) * 40}ms` }}
            >
              {/* Timeline rail: dot + connecting line down to the next entry */}
              <div className="relative flex w-3 shrink-0 flex-col items-center">
                <SeverityDot severity={incident.severity} className="mt-1.5 h-2.5 w-2.5 ring-4 ring-card" />
                {!isLast && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold text-foreground">{cameraLabel}</span>
                  <span className="shrink-0 font-mono text-[11px] tracking-tight text-muted-foreground">
                    {formatRelativeTime(incident.received_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                  {severityLabel(incident.severity)}
                </p>

                {incident.entities?.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {incident.entities.map((e, i) => (
                      <p key={i} className="text-xs leading-relaxed text-foreground">
                        <span className="font-semibold">{e.label[0].toUpperCase() + e.label.slice(1)}</span>
                        {e.description ? ` — ${e.description}` : ""}
                      </p>
                    ))}
                  </div>
                )}

                {incident.matches_rule === false && (
                  <p className="mt-1.5 text-xs text-muted-foreground italic">
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

                {!isLast && <div className="mt-4 h-px bg-border" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

