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
import { Plus } from "lucide-react";

type CameraKind = "rtsp" | "mobile" | "webcam" | "laptop" | "file";

const KIND_COPY: Record<
  CameraKind,
  { label: string; help: string; placeholder: string; idHint: string }
> = {
  rtsp: {
    label: "IP / RTSP Camera",
    help: "Most home security and PoE cameras expose an RTSP stream. Check the camera's manual or app for its RTSP URL.",
    placeholder: "rtsp://username:password@192.168.1.50:554/stream1",
    idHint: "front_door",
  },
  mobile: {
    label: "Mobile Phone Camera",
    help:
      'Turn a spare phone into a camera with a free app (e.g. "IP Webcam" for Android, "EpocCam" for iOS), then paste the stream URL it shows on-screen.',
    placeholder: "http://192.168.1.23:8080/video",
    idHint: "kitchen_phone",
  },
  webcam: {
    label: "USB Webcam",
    help: "A locally attached webcam, referenced by its device index (0 is usually the first/built-in camera).",
    placeholder: "0",
    idHint: "desk_webcam",
  },
  laptop: {
    label: "This Device's Webcam",
    help:
      "Streams directly from this browser's own camera - no server-side hardware access needed. You'll be asked for camera permission, and this browser tab must stay open for the feed to keep streaming.",
    placeholder: "",
    idHint: "laptop_webcam",
  },
  file: {
    label: "Demo / Video File",
    help: "Useful for testing the pipeline without real hardware - point to any local video file path.",
    placeholder: "sample.mp4",
    idHint: "demo",
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a camera</DialogTitle>
          <DialogDescription>
            Pick the kind of camera you&apos;re adding. You can connect as many as you like.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={kind} onValueChange={(v) => setKind(v as CameraKind)}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="rtsp">IP</TabsTrigger>
            <TabsTrigger value="mobile">Mobile</TabsTrigger>
            <TabsTrigger value="webcam">Webcam</TabsTrigger>
            <TabsTrigger value="laptop">This Device</TabsTrigger>
            <TabsTrigger value="file">Demo</TabsTrigger>
          </TabsList>
          <TabsContent value={kind} className="flex flex-col gap-3 pt-1">
            <p className="text-xs leading-relaxed text-muted-foreground">{copy.help}</p>

            <div>
              <Label htmlFor="new-cam-id" className="mb-1.5">Camera Name</Label>
              <Input
                id="new-cam-id"
                placeholder={copy.idHint}
                value={id}
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            {kind !== "laptop" && (
              <div>
                <Label htmlFor="new-cam-source" className="mb-1.5">{copy.label} Source</Label>
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
