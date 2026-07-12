"""
Incident media capture: saves a snapshot photo and/or a short MP4 clip of a
dispatched incident's event buffer to disk, when config.SAVE_INCIDENT_MEDIA
is enabled. Files are written under config.MEDIA_DIR/<camera_id>/ and served
back to the dashboard by api_server.py, which mounts MEDIA_DIR at /media.
"""
import os
import time
import uuid

import cv2

from config import config


def _event_dir(camera_id: str) -> str:
    path = os.path.join(config.MEDIA_DIR, camera_id)
    os.makedirs(path, exist_ok=True)
    return path


def save_incident_media(camera_id: str, frames: list) -> dict:
    """Writes a photo (middle frame of the event buffer) and/or an MP4 clip
    (the full buffer) for one dispatched incident. Returns a dict with
    "photo_url"/"video_url" keys (relative, e.g. "/media/front_door/xyz.jpg")
    for whichever artifacts were saved and enabled; omits keys that weren't."""
    if not frames:
        return {}

    result: dict = {}
    event_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
    out_dir = _event_dir(camera_id)

    if config.SAVE_INCIDENT_PHOTOS:
        try:
            photo_path = os.path.join(out_dir, f"{event_id}.jpg")
            mid_frame = frames[len(frames) // 2]
            cv2.imwrite(photo_path, mid_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            result["photo_url"] = f"/media/{camera_id}/{event_id}.jpg"
        except Exception as e:
            print(f"[{camera_id}][Media] Failed to save incident photo: {e}")

    if config.SAVE_INCIDENT_VIDEOS:
        try:
            video_path = os.path.join(out_dir, f"{event_id}.mp4")
            h, w = frames[0].shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(video_path, fourcc, config.MEDIA_VIDEO_FPS, (w, h))
            for f in frames:
                if f.shape[:2] != (h, w):
                    f = cv2.resize(f, (w, h))
                writer.write(f)
            writer.release()
            result["video_url"] = f"/media/{camera_id}/{event_id}.mp4"
        except Exception as e:
            print(f"[{camera_id}][Media] Failed to save incident video: {e}")

    return result
