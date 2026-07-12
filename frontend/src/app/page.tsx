"use client";

import { useEffect, useMemo, useState } from "react";
import { api, connectIncidentSocket, type Camera, type Incident } from "@/lib/api";
import { CameraCard } from "@/components/camera-card";
import { IncidentFeed } from "@/components/incident-feed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AddCameraDialog } from "@/components/add-camera-dialog";
import { CheckCircle2, House, ShieldAlert } from "lucide-react";

const REFRESH_INTERVAL_MS = 5000;

/** Placeholder tile shown in the camera grid while the first load is in flight. */
function CameraCardSkeleton() {
  return (
    <Card className="gap-0 overflow-hidden border-border bg-card py-0 shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="border-t border-border px-3 py-2">
        <Skeleton className="h-3 w-32" />
      </div>
    </Card>
  );
}

function IncidentFeedSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" />
          <div className="flex-1 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [camerasRes, incidentsRes] = await Promise.all([
          api.listCameras(),
          api.getIncidents(50),
        ]);
        if (!cancelled) {
          setCameras(camerasRes.cameras);
          setIncidents(incidentsRes.incidents);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);

    // Prepend any newly pushed incident immediately, without waiting for the
    // next poll cycle - keeps the feed in sync with the toast alerts.
    const disconnect = connectIncidentSocket((incident) => {
      setIncidents((prev) => [incident, ...prev].slice(0, 50));
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      disconnect();
    };
  }, []);

  const criticalCount = useMemo(
    () => incidents.filter((i) => i.severity === "high" || i.severity === "critical").length,
    [incidents]
  );

  const handleRemoveCamera = async (id: string) => {
    try {
      const res = await api.deleteCamera(id);
      setCameras(res.cameras);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 flex flex-col gap-6 sm:py-12 sm:gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">
            Home
          </h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Here&apos;s what&apos;s happening around your property.
          </p>
        </div>
        <AddCameraDialog onSaved={setCameras} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold tracking-tight text-foreground">
            Your Cameras {cameras.length > 0 && `(${cameras.length})`}
          </h2>
          {loading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <CameraCardSkeleton key={i} />
              ))}
            </div>
          ) : cameras.length === 0 ? (
            <Card className="animate-fade-up border-border bg-card shadow-sm">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                  <House className="h-8 w-8 text-primary" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">Let&apos;s get your first camera set up</p>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                    Use a phone, a laptop, or a camera you already own — it only takes a minute,
                    and no technical setup is required.
                  </p>
                </div>
                <AddCameraDialog onSaved={setCameras} />
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {cameras.map((cam, idx) => (
                <div key={cam.id} className="animate-fade-up" style={{ animationDelay: `${idx * 60}ms` }}>
                  <CameraCard camera={cam} onRemove={handleRemoveCamera} />
                </div>
              ))}
            </div>
          )}
        </div>
          <Card className="rounded-sm">
          <CardContent className="flex flex-col gap-3 py-4 bg-card border-border p-4">

            {loading ? <IncidentFeedSkeleton /> : <IncidentFeed incidents={incidents} />}
          </CardContent>
      </Card>
      </div>
    </div>
  );
}

