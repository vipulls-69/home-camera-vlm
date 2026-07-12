"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, type Camera } from "@/lib/api";
import { formatCameraLabel } from "@/lib/utils";
import { Trash2 } from "lucide-react";

// ~10 FPS refresh via still-image polling. Far more reliable across browsers
// than relying on a raw multipart/x-mixed-replace <img> stream, which some
// browsers/dev proxies buffer and only ever paint the first frame of. Matches
// the backend's LIVE_VIEW_FPS publish rate (config.py) so the preview looks
// like real video instead of a slideshow.
const POLL_INTERVAL_MS = 100;

/** Live polled snapshot view for one camera, backed by GET /api/stream/{id}/snapshot. */
export function CameraCard({
  camera,
  onRemove,
}: {
  camera: Camera;
  /** When provided, shows a trash button on the card to remove this camera. */
  onRemove?: (id: string) => void;
}) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const failCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;
    // Require a few consecutive failures before flipping to "offline" - a
    // single dropped/slow poll (e.g. the backend hasn't produced its very
    // first frame yet, or a transient network blip) shouldn't flash the
    // whole tile into an error state.
    const FAILURE_THRESHOLD = 4;

    const poll = async () => {
      try {
        const res = await fetch(api.snapshotUrl(camera.id), { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        // Decode the frame off-screen first so the swap to <img src> is an
        // instant, already-painted update instead of a blank/flicker while
        // the browser decodes the new JPEG - this is what made the feed feel
        // "buffery" even though frames were arriving on time.
        const preload = new Image();
        preload.src = url;
        if (preload.decode) {
          await preload.decode().catch(() => {});
        }
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setFrameUrl(url);
        failCountRef.current = 0;
        setErrored(false);
      } catch {
        if (cancelled) return;
        failCountRef.current += 1;
        if (failCountRef.current >= FAILURE_THRESHOLD) setErrored(true);
      } finally {
        if (!cancelled) pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();
    const clockTimer = setInterval(() => setNow(new Date()), 1000);

    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearInterval(clockTimer);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [camera.id]);

  return (
    <Card className="animate-fade-up transition-surface gap-0 overflow-hidden border-border bg-card py-0 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between border-b border-border py-2.5">
        <CardTitle className="text-sm font-medium text-foreground">
          {formatCameraLabel(camera.id)}
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                errored ? "bg-red-500" : "bg-emerald-500"
              }`}
            />
            <span
              className={`text-[11px] font-medium ${
                errored ? "text-red-600" : "text-emerald-600"
              }`}
            >
              {errored ? "Offline" : "Live"}
            </span>
          </div>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => {
                if (confirm(`Remove "${formatCameraLabel(camera.id)}"?`)) onRemove(camera.id);
              }}
              aria-label={`Remove ${formatCameraLabel(camera.id)}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="relative aspect-video w-full overflow-hidden bg-neutral-900">
          {frameUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={frameUrl}
              alt={`${formatCameraLabel(camera.id)} live feed`}
              decoding="async"
              className="h-full w-full object-cover"
            />
          )}

        </div>
      </CardContent>
    </Card>
  );
}
