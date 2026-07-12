"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, BROWSER_CAMERA_SOURCE, type Camera } from "@/lib/api";

const CAMERA_POLL_MS = 5000;
const CAPTURE_INTERVAL_MS = 250;

/**
 * Mounted once, globally (see layout.tsx). Watches the camera list for any
 * entry whose source is the "browser" sentinel (added via the "This
 * Device's Webcam" option in the Add Camera dialog) and, for each one,
 * captures this browser's own webcam via getUserMedia and periodically
 * uploads JPEG frames to POST /api/ingest/{id}. The backend process itself
 * has no access to the operator's physical laptop/phone camera, so this is
 * the only way to feed it into the pipeline.
 *
 * Renders nothing visible - it's a background streaming worker that keeps
 * running as long as the dashboard tab stays open.
 */
export function WebcamUploader() {
  // One entry per active browser camera_id, tracking its stream/intervals so
  // we can tear them down cleanly when the camera is removed or replaced.
  const activeRef = useRef<
    Map<string, { stream: MediaStream; video: HTMLVideoElement; stopped: boolean }>
  >(new Map());

  useEffect(() => {
    let cancelled = false;
    const active = activeRef.current;

    const stopCamera = (id: string) => {
      const entry = active.get(id);
      if (!entry) return;
      entry.stopped = true;
      entry.stream.getTracks().forEach((t) => t.stop());
      entry.video.srcObject = null;
      active.delete(id);
    };

    const startCamera = async (id: string) => {
      if (active.has(id)) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();

        const canvas = document.createElement("canvas");
        const entry = { stream, video, stopped: false };
        active.set(id, entry);

        // Self-scheduling capture loop instead of a fixed setInterval: each
        // frame waits for the previous upload to actually finish before
        // capturing the next one, so a slow network/backend can't pile up
        // in-flight requests (which was compounding the feed's lag/buffering).
        const captureLoop = async () => {
          while (!entry.stopped && !cancelled) {
            const start = performance.now();
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const blob: Blob | null = await new Promise((resolve) =>
                  canvas.toBlob(resolve, "image/jpeg", 0.8)
                );
                if (blob && !entry.stopped && !cancelled) {
                  await api.ingestFrame(id, blob).catch(() => {});
                }
              }
            }
            const elapsed = performance.now() - start;
            const wait = Math.max(0, CAPTURE_INTERVAL_MS - elapsed);
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        };
        captureLoop();
      } catch (err) {
        toast.error(
          `Couldn't access this device's webcam for "${id}": ${(err as Error).message}`
        );
      }
    };


    const reconcile = (cameras: Camera[]) => {
      const desired = new Set(
        cameras.filter((c) => c.source === BROWSER_CAMERA_SOURCE).map((c) => c.id)
      );

      for (const id of Array.from(active.keys())) {
        if (!desired.has(id)) stopCamera(id);
      }
      for (const id of desired) {
        if (!active.has(id)) startCamera(id);
      }
    };

    const poll = async () => {
      try {
        const res = await api.listCameras();
        if (!cancelled) reconcile(res.cameras);
      } catch {
        // Backend momentarily unreachable - leave existing streams running.
      }
    };

    poll();
    const pollTimer = setInterval(poll, CAMERA_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      for (const id of Array.from(active.keys())) stopCamera(id);
    };
  }, []);

  return null;
}
