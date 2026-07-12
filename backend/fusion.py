"""
Multi-camera fusion.

Correlates incidents from independent camera pipelines that land close
together in time into a single fused incident timeline, instead of firing N
separate alerts. If FUSION_ENABLED is False, incidents are dispatched to
alerting immediately and independently.
"""
import asyncio
import time
from dataclasses import dataclass
from config import config

_SEVERITY_RANK = {level: i for i, level in enumerate(config.SEVERITY_LEVELS)}


@dataclass
class TimelineEvent:
    camera_id: str
    timestamp: float
    incident: dict


class FusionEngine:
    def __init__(self, alert_dispatcher, correlation_window_sec: float = None, flush_delay_sec: float = None):
        self.alert_dispatcher = alert_dispatcher
        self.correlation_window_sec = correlation_window_sec or config.FUSION_CORRELATION_WINDOW_SEC
        self.flush_delay_sec = flush_delay_sec or config.FUSION_FLUSH_DELAY_SEC
        self._pending: list[TimelineEvent] = []
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task | None = None

    async def submit(self, camera_id: str, incident: dict) -> dict:
        """
        Called by each camera pipeline whenever it produces an incident report.
        Buffers the event for a short grace period so correlated events from
        other cameras can be merged in before dispatching to alerting.
        """
        if not config.FUSION_ENABLED:
            return await self.alert_dispatcher.dispatch(incident)

        now = time.monotonic()
        async with self._lock:
            self._pending.append(TimelineEvent(camera_id, now, incident))
            if self._flush_task:
                self._flush_task.cancel()
            self._flush_task = asyncio.create_task(self._flush_after_delay())
        return {}

    async def _flush_after_delay(self):
        try:
            await asyncio.sleep(self.flush_delay_sec)
        except asyncio.CancelledError:
            return
        await self._flush()

    async def _flush(self):
        async with self._lock:
            if not self._pending:
                return
            now = time.monotonic()
            window_start = now - self.correlation_window_sec
            correlated = [e for e in self._pending if e.timestamp >= window_start]
            self._pending = []

        if not correlated:
            return

        fused = self._build_fused_incident(correlated)
        cameras = sorted(set(e.camera_id for e in correlated))
        print(f"[Fusion] Correlated {len(correlated)} event(s) across "
              f"{len(cameras)} camera(s) {cameras} into one incident timeline.")

        await self.alert_dispatcher.dispatch(fused)

    def _build_fused_incident(self, events: list[TimelineEvent]) -> dict:
        events_sorted = sorted(events, key=lambda e: e.timestamp)
        cameras = sorted(set(e.camera_id for e in events_sorted))
        t0 = events_sorted[0].timestamp

        fused_severity = max(
            (e.incident.get("severity", "low") for e in events_sorted),
            key=lambda s: _SEVERITY_RANK.get(s, 0),
            default="low",
        )

        timeline = [
            {
                "camera_id": e.camera_id,
                "offset_sec": round(e.timestamp - t0, 2),
                "summary": e.incident.get("summary"),
                "severity": e.incident.get("severity"),
                "entities": e.incident.get("entities", []),
                "photo_url": e.incident.get("photo_url"),
                "video_url": e.incident.get("video_url"),
            }
            for e in events_sorted
        ]

        summary = (
            f"Correlated activity across {len(cameras)} camera(s) ({', '.join(cameras)}): "
            + " -> ".join(f"[{e.camera_id}] {e.incident.get('summary', '')[:80]}" for e in events_sorted)
        )

        # Surface the first event's saved media at the top level too, so a
        # single-camera "fused" incident (the common case) still shows a
        # photo/video without the dashboard needing to dig into the timeline.
        first_with_media = next((e for e in events_sorted if e.incident.get("photo_url") or e.incident.get("video_url")), None)

        return {
            "summary": summary,
            "severity": fused_severity,
            "matches_rule": any(e.incident.get("matches_rule", True) for e in events_sorted),
            "cameras": cameras,
            "timeline": timeline,
            "entities": [ent for e in events_sorted for ent in e.incident.get("entities", [])],
            "detections": [d for e in events_sorted for d in e.incident.get("detections", [])],
            "fused": True,
            **({"photo_url": first_with_media.incident.get("photo_url")} if first_with_media and first_with_media.incident.get("photo_url") else {}),
            **({"video_url": first_with_media.incident.get("video_url")} if first_with_media and first_with_media.incident.get("video_url") else {}),
        }
