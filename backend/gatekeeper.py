import time
from dataclasses import dataclass, field
from ultralytics import YOLO
import numpy as np
from config import config, camera_setting


@dataclass
class Detection:
    track_id: int | None
    cls_id: int
    class_name: str
    confidence: float
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2


@dataclass
class GateResult:
    triggered: bool
    detections: list[Detection] = field(default_factory=list)
    new_track_ids: set[int] = field(default_factory=set)


class Gatekeeper:
    def __init__(self, camera_id: str | None = None):
        # When set, Detection Tuning fields resolve this camera's per-camera
        # override (config.CAMERA_DETECTION_OVERRIDES) before falling back to
        # the global default - see config.camera_setting.
        self.camera_id = camera_id
        self.model = YOLO(config.YOLO_MODEL)
        self.target_classes = config.TARGET_CLASSES
        # Last trigger time per track ID, so a loitering subject produces one
        # incident instead of re-triggering every frame.
        self._last_triggered: dict[int, float] = {}
        self._last_seen: dict[int, float] = {}
        # Fallback cooldown for detections with no stable track ID, keyed by
        # class name so e.g. a persistent untracked "person" doesn't suppress
        # a newly-appearing untracked "car" (or vice versa).
        self._last_untracked_trigger: dict[str, float] = {}
        # Recently-triggered boxes (class_name, bbox, timestamp), used as a
        # spatial backstop when the tracker assigns a subject a new ID even
        # though it never actually left the frame - see _find_spatial_match.
        self._recent_boxes: list[dict] = []

    def _cfg(self, key: str):
        return camera_setting(config, self.camera_id, key)

    def _forget_stale_tracks(self, now: float):
        stale_ids = [
            tid for tid, last_seen in self._last_seen.items()
            if (now - last_seen) > self._cfg("track_stale_sec")
        ]
        for tid in stale_ids:
            self._last_seen.pop(tid, None)
            self._last_triggered.pop(tid, None)
        self._recent_boxes = [
            b for b in self._recent_boxes if (now - b["time"]) <= self._cfg("track_cooldown_sec")
        ]

    @staticmethod
    def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
        if inter <= 0:
            return 0.0
        area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
        area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
        union = area_a + area_b - inter
        return inter / union if union > 0 else 0.0

    def _find_spatial_match(self, class_name: str, bbox: tuple[float, float, float, float], now: float) -> dict | None:
        """Finds a recently-triggered box of the same class that overlaps
        closely enough to be the same physical subject, even if the tracker
        gave it a different (or no) ID. Acts as a backstop against ID churn."""
        if not self._cfg("spatial_dedup_enabled"):
            return None
        best = None
        best_iou = self._cfg("spatial_dedup_iou_threshold")
        for entry in self._recent_boxes:
            if entry["class_name"] != class_name:
                continue
            if (now - entry["time"]) > self._cfg("track_cooldown_sec"):
                continue
            iou = self._iou(entry["bbox"], bbox)
            if iou >= best_iou:
                best_iou = iou
                best = entry
        return best

    def detect(self, frame: np.ndarray) -> GateResult:
        """
        Run detection and track-based de-duplication. Filters out non-target
        classes, detections too small/far away to matter, and suppresses
        re-triggering the same tracked subject within the cooldown window, so
        a loitering subject produces one event - but a new subject/object
        entering the frame (a new track ID, or a new untracked class) still
        triggers immediately even while an existing one is present.
        """
        now = time.monotonic()
        self._forget_stale_tracks(now)

        # persist=True keeps ByteTrack's internal state alive across calls so
        # track IDs remain stable for the same subject across frames.
        results = self.model.track(
            frame, persist=True, tracker=config.TRACKER, verbose=False
        )[0]

        frame_h, frame_w = frame.shape[:2]
        frame_area = frame_w * frame_h

        detections: list[Detection] = []
        new_track_ids: set[int] = set()
        triggered = False

        boxes = results.boxes
        track_ids = boxes.id
        for i, box in enumerate(boxes):
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
            track_id = int(track_ids[i]) if track_ids is not None else None

            if cls_id not in self.target_classes or conf < self._cfg("confidence_threshold"):
                continue

            class_name = config.COCO_CLASS_NAMES.get(cls_id, str(cls_id))

            # Distance approximation: skip subjects that are too small/far
            # away to matter (e.g. cars/pedestrians on a distant road), based
            # on how much of the frame their bounding box covers.
            if frame_area > 0:
                box_area_ratio = (max(0.0, x2 - x1) * max(0.0, y2 - y1)) / frame_area
                min_ratio = config.MIN_DETECTION_AREA_RATIO_BY_CLASS.get(
                    class_name, self._cfg("min_detection_area_ratio")
                )
                if min_ratio > 0 and box_area_ratio < min_ratio:
                    continue

            bbox = (x1, y1, x2, y2)
            detections.append(Detection(track_id, cls_id, class_name, conf, bbox))

            if track_id is not None:
                self._last_seen[track_id] = now
                last_trigger = self._last_triggered.get(track_id)
                is_new = last_trigger is None or (now - last_trigger) > self._cfg("track_cooldown_sec")
            else:
                # No stable track ID; apply the same cooldown per-class so a
                # persistent untracked subject doesn't suppress a genuinely
                # new kind of object showing up alongside it.
                last_trigger = self._last_untracked_trigger.get(class_name)
                is_new = last_trigger is None or (now - last_trigger) > self._cfg("track_cooldown_sec")
                if is_new:
                    self._last_untracked_trigger[class_name] = now

            spatial_match = None
            if is_new:
                # Backstop: even though the tracker thinks this is a new/newly
                # -reassigned ID, check whether it overlaps closely with a box
                # that was already triggered recently - if so, it's almost
                # certainly the same physical subject that never left, so
                # suppress it instead of firing another VLM call.
                spatial_match = self._find_spatial_match(class_name, bbox, now)
                if spatial_match is not None:
                    is_new = False
                    spatial_match["time"] = now
                    spatial_match["bbox"] = bbox
                    if track_id is not None:
                        self._last_triggered[track_id] = spatial_match.get("time", now)

            if is_new:
                triggered = True
                new_track_ids.add(track_id if track_id is not None else -1)
                self._recent_boxes.append({"class_name": class_name, "bbox": bbox, "time": now})

        for tid in new_track_ids:
            if tid != -1:
                self._last_triggered[tid] = now

        return GateResult(triggered=triggered, detections=detections, new_track_ids=new_track_ids)
