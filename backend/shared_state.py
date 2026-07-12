"""
Shared in-process state connecting the video pipeline (main.py) to the
dashboard API layer (api_server.py). Both run in the same asyncio event loop,
so plain in-memory structures + asyncio primitives are sufficient (no external
broker needed for a single-process deployment).
"""
import asyncio
import time
from collections import deque
from dataclasses import dataclass, field


@dataclass
class SharedState:
    # Latest encoded JPEG bytes per camera_id, used to serve the MJPEG feed.
    latest_frames: dict = field(default_factory=dict)
    frame_updated_at: dict = field(default_factory=dict)

    # Rolling history of incident reports, newest first.
    incidents: deque = field(default_factory=lambda: deque(maxlen=200))

    # One asyncio.Queue per connected WebSocket client for real-time push of
    # new incidents.
    _subscribers: list = field(default_factory=list)

    # For "browser" sources, the dashboard POSTs JPEG frames to
    # /api/ingest/{camera_id}. One small queue per camera_id holds the most
    # recent frames for run_browser_camera_pipeline to consume.
    ingest_queues: dict = field(default_factory=dict)

    def update_frame(self, camera_id: str, jpeg_bytes: bytes):
        self.latest_frames[camera_id] = jpeg_bytes
        self.frame_updated_at[camera_id] = time.time()

    def get_ingest_queue(self, camera_id: str) -> "asyncio.Queue":
        queue = self.ingest_queues.get(camera_id)
        if queue is None:
            queue = asyncio.Queue(maxsize=2)
            self.ingest_queues[camera_id] = queue
        return queue

    def push_ingested_frame(self, camera_id: str, jpeg_bytes: bytes):
        """Queue a browser-uploaded frame, dropping the oldest if full so the
        feed stays close to real-time."""
        queue = self.get_ingest_queue(camera_id)
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(jpeg_bytes)

    def drop_ingest_queue(self, camera_id: str):
        self.ingest_queues.pop(camera_id, None)

    def add_incident(self, incident: dict):
        record = dict(incident)
        record.setdefault("received_at", time.time())
        self.incidents.appendleft(record)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(record)
            except asyncio.QueueFull:
                pass  # Drop for slow/disconnected clients rather than block.

    def subscribe(self) -> "asyncio.Queue":
        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: "asyncio.Queue"):
        if queue in self._subscribers:
            self._subscribers.remove(queue)


shared_state = SharedState()
