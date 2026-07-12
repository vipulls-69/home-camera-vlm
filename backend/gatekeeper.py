import time
from dataclasses import dataclass, field
from ultralytics import YOLO
import numpy as np
from config import config


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
    def __init__(self):
        self.model = YOLO(config.YOLO_MODEL)
        self.target_classes = config.TARGET_CLASSES
        # Last trigger time per track ID, so a loitering subject produces one
        # incident instead of re-triggering every frame.
        self._last_triggered: dict[int, float] = {}
        self._last_seen: dict[int, float] = {}
        # Fallback cooldown for detections with no stable track ID.
        self._last_untracked_trigger: float | None = None

    def _forget_stale_tracks(self, now: float):
        stale_ids = [
            tid for tid, last_seen in self._last_seen.items()
            if (now - last_seen) > config.TRACK_STALE_SEC
        ]
        for tid in stale_ids:
            self._last_seen.pop(tid, None)
            self._last_triggered.pop(tid, None)

    def detect(self, frame: np.ndarray) -> GateResult:
        """
        Run detection and track-based de-duplication. Filters out non-target
        classes and suppresses re-triggering the same tracked subject within
        the cooldown window, so a loitering subject produces one event.
        """
        now = time.monotonic()
        self._forget_stale_tracks(now)

        # persist=True keeps ByteTrack's internal state alive across calls so
        # track IDs remain stable for the same subject across frames.
        results = self.model.track(
            frame, persist=True, tracker=config.TRACKER, verbose=False
        )[0]

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

            if cls_id not in self.target_classes or conf < config.CONFIDENCE_THRESHOLD:
                continue

            class_name = config.COCO_CLASS_NAMES.get(cls_id, str(cls_id))
            detections.append(Detection(track_id, cls_id, class_name, conf, (x1, y1, x2, y2)))

            if track_id is not None:
                self._last_seen[track_id] = now
                last_trigger = self._last_triggered.get(track_id)
                is_new = last_trigger is None or (now - last_trigger) > config.TRACK_COOLDOWN_SEC
            else:
                # No stable track ID; apply the same cooldown as tracked
                # subjects to avoid repeated triggers.
                is_new = (
                    self._last_untracked_trigger is None
                    or (now - self._last_untracked_trigger) > config.TRACK_COOLDOWN_SEC
                )
                if is_new:
                    self._last_untracked_trigger = now

            if is_new:
                triggered = True
                new_track_ids.add(track_id if track_id is not None else -1)

        for tid in new_track_ids:
            if tid != -1:
                self._last_triggered[tid] = now

        return GateResult(triggered=triggered, detections=detections, new_track_ids=new_track_ids)
