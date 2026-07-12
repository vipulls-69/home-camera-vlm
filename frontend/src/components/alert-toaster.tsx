"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { connectIncidentSocket, type Incident } from "@/lib/api";
import { playSeverityAlert, unlockAudio } from "@/lib/sound";
import { Badge } from "@/components/ui/badge";
import { severityBadgeClass } from "@/components/severity";

/**
 * Mounted once at the root layout. Subscribes to the backend's real-time
 * incident WebSocket and, for every new (already rule-filtered/fused)
 * incident, shows an in-app toast and plays a severity-based sound +
 * haptic vibration pattern (Multi-Modal Alert Routing's "in_app" channel).
 */
export function AlertToaster() {
  const unlockedRef = useRef(false);

  useEffect(() => {
    const unlock = () => {
      if (!unlockedRef.current) {
        unlockAudio();
        unlockedRef.current = true;
      }
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    const disconnect = connectIncidentSocket((incident: Incident) => {
      playSeverityAlert(incident.severity ?? "unknown");

      const cameraLabel = incident.fused
        ? `${(incident.cameras || []).join(", ")} (fused)`
        : incident.camera_id || "camera";

      toast.custom(() => (
        <div className="flex flex-col gap-1 rounded-md border bg-background p-3 shadow-lg min-w-[300px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">Security Alert - {cameraLabel}</span>
            <Badge className={severityBadgeClass(incident.severity)}>{incident.severity}</Badge>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-3">{incident.summary}</p>
        </div>
      ));
    });

    return () => {
      disconnect();
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  return null;
}
