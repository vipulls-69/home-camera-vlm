"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, BROWSER_CAMERA_SOURCE, type Camera } from "@/lib/api";
import { DETECTION_TEMPLATES } from "@/lib/detection-templates";
import { Plus } from "lucide-react";

// New cameras default to the "Home" detection tuning preset, the most
// broadly sensible starting point (quiet residential scenes), so a freshly
// connected camera isn't left on bare global defaults until someone visits
// the Detection Tuning tab.
const DEFAULT_DETECTION_TEMPLATE = DETECTION_TEMPLATES.find((t) => t.label === "Home");

type CameraKind = "rtsp" | "mobile" | "webcam" | "laptop" | "file";

const KIND_COPY: Record<
  CameraKind,
  { label: string; help: string; placeholder: string; idHint: string }
> = {
  rtsp: {
    label: "IP / RTSP Camera",
    help: "Most home security and PoE cameras expose an RTSP stream. Check the camera's manual or app for its RTSP URL.",
    placeholder: "Camera URL",
    idHint: "Front Door Cam",
  },
  mobile: {
    label: "Mobile Phone Camera",
    help:
      'Turn a spare phone into a camera with a free app (e.g. "IP Webcam" for Android, "EpocCam" for iOS), then paste the stream URL it shows on-screen.',
    placeholder: "URL Shown in App",
    idHint: "John's Phone Cam",
  },
  webcam: {
    label: "USB Webcam",
    help: "A locally attached webcam, referenced by its device index.",
    placeholder: "USB Port",
    idHint: "Living Room Webcam",
  },
  laptop: {
    label: "This Device's Webcam",
    help:
      "Streams directly from this browser's own camera. You may need to grant permission for the browser to access the camera.",
    placeholder: "This Device",
    idHint: "Laptop Webcam",
  },
  file: {
    label: "Demo / Video File",
    help: "Useful for testing the pipeline without real hardware - point to any local video file path.",
    placeholder: "Video File",
    idHint: "File Name",
  },
};

export function AddCameraDialog({ onSaved }: { onSaved: (cameras: Camera[]) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CameraKind>("rtsp");
  const [id, setId] = useState("");
  const [source, setSource] = useState("");
  const [saving, setSaving] = useState(false);

  const copy = KIND_COPY[kind];

  const reset = () => {
    setId("");
    setSource("");
    setKind("rtsp");
  };

  const handleSave = async () => {
    const isLaptop = kind === "laptop";
    if (!id.trim() || (!isLaptop && !source.trim())) {
      toast.error("Give your camera a name and a source.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.upsertCamera({
        id: id.trim(),
        source: isLaptop ? BROWSER_CAMERA_SOURCE : source.trim(),
      });
      if (DEFAULT_DETECTION_TEMPLATE) {
        // Best-effort - don't block/fail camera creation if this call fails.
        api.updateCameraDetectionConfig(id.trim(), DEFAULT_DETECTION_TEMPLATE.values).catch(() => {});
      }
      onSaved(res.cameras);
      toast.success(`"${id}" connected. It'll appear on the dashboard automatically.`);
      setOpen(false);
      reset();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-11 px-5">
          <Plus data-icon="inline-start" />
          Connect a Camera
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a camera</DialogTitle>
          <DialogDescription>
            Pick the kind of camera you&apos;re adding. You can connect as many as you like.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={kind} onValueChange={(v) => setKind(v as CameraKind)}>
          <TabsList className="grid h-auto w-full grid-cols-5 gap-1">
            <TabsTrigger value="rtsp" className="whitespace-normal px-1 py-1.5 text-xs leading-tight">Camera</TabsTrigger>
            <TabsTrigger value="mobile" className="whitespace-normal px-1 py-1.5 text-xs leading-tight">Mobile</TabsTrigger>
            <TabsTrigger value="webcam" className="whitespace-normal px-1 py-1.5 text-xs leading-tight">Webcam</TabsTrigger>
            <TabsTrigger value="laptop" className="whitespace-normal px-1 py-1.5 text-xs leading-tight">My Device</TabsTrigger>
            <TabsTrigger value="file" className="whitespace-normal px-1 py-1.5 text-xs leading-tight">Video File</TabsTrigger>
          </TabsList>
          <TabsContent value={kind} className="flex flex-col gap-4 pt-4">
            <p className="text-xs leading-relaxed text-muted-foreground">{copy.help}</p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-cam-id">Camera Name</Label>
              <Input
                id="new-cam-id"
                placeholder={copy.idHint}
                value={id}
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            {kind !== "laptop" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-cam-source">{copy.label} Source</Label>
                <Input
                  id="new-cam-source"
                  placeholder={copy.placeholder}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Connecting..." : "Connect Camera"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
