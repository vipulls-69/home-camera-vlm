"""
Dashboard API (FastAPI) - runs in the same asyncio event loop as the video
pipeline (main.py) and exposes:

  GET/POST/DELETE /api/cameras            - manage camera feeds
  GET/PUT         /api/rules               - manage per-camera natural-language rules
  GET/PUT         /api/rules/{id}/constraints - structured object/time/day rule constraints
  GET             /api/detection-classes   - object classes available for the rule builder
  GET/PUT         /api/alerts/config       - manage alert channels/thresholds/webhooks
  GET/PUT         /api/llm/config          - manage the VLM provider API key/model
  GET/PUT         /api/detection/config     - manage motion/gatekeeper/fusion tuning knobs
  GET/PUT/DELETE  /api/detection/templates/{name} - user-saved custom Detection Tuning presets
  GET/PUT/DELETE  /api/detection/config/{id} - per-camera Detection Tuning overrides
  GET/PUT         /api/cameras/{id}/severity - force a fixed severity for one camera's incidents
  GET             /api/incidents           - recent incident history (REST snapshot)
  GET             /api/stream/{id}         - MJPEG live view for one camera (legacy)
  GET             /api/stream/{id}/snapshot - single latest JPEG frame, polled by the dashboard
  POST            /api/ingest/{id}         - browser-pushed JPEG frame (laptop/phone webcam
                                              captured client-side via getUserMedia, for a
                                              camera whose source is the "browser" sentinel)
  WS              /ws/incidents            - real-time push of new incidents,
                                              used to drive in-app alert toasts
                                              with severity-based sound/haptics.

The RulesEngine and pipeline's shared_state are injected via bind_* so this
module can be imported without creating circular startup ordering issues.
"""
import asyncio
import json
import os

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.requests import ClientDisconnect

from config import config, save_config_overrides, camera_setting, _DETECTION_CONFIG_FIELDS
from shared_state import shared_state

app = FastAPI(title="AI Video Pipeline Dashboard API")

# Dev-friendly CORS: the Next.js dashboard runs on a different port/origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serves saved incident photos/videos (see media_store.py) at /media/... so
# the dashboard can render/download them directly by URL.
os.makedirs(config.MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=config.MEDIA_DIR), name="media")

_rules_engine = None
_vlm_client = None


def bind_rules_engine(engine):
    """Called once from main.py so rule edits take effect immediately."""
    global _rules_engine
    _rules_engine = engine


def bind_vlm_client(client):
    """Called once from main.py so a new LLM API key saved from the dashboard
    takes effect immediately, without a process restart."""
    global _vlm_client
    _vlm_client = client


class CameraIn(BaseModel):
    id: str
    source: str


class RuleIn(BaseModel):
    rule: str


class AlertConfigIn(BaseModel):
    channels: list[str] | None = None
    min_severity: dict[str, str] | None = None
    slack_webhook_url: str | None = None
    generic_webhook_url: str | None = None
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    sms_to: str | None = None
    pagerduty_routing_key: str | None = None


class LLMConfigIn(BaseModel):
    api_key: str | None = None
    model: str | None = None


class MediaConfigIn(BaseModel):
    save_media: bool | None = None
    save_photos: bool | None = None
    save_videos: bool | None = None


class DetectionConfigIn(BaseModel):
    """Partial update for the Detection Tuning panel - every field is
    optional so the dashboard can send just what changed (or a whole preset
    template in one call)."""
    motion_threshold: float | None = None
    adaptive_motion_enabled: bool | None = None
    motion_threshold_min: float | None = None
    motion_threshold_max: float | None = None
    confidence_threshold: float | None = None
    min_detection_area_ratio: float | None = None
    track_cooldown_sec: float | None = None
    track_stale_sec: float | None = None
    spatial_dedup_enabled: bool | None = None
    spatial_dedup_iou_threshold: float | None = None
    event_diff_enabled: bool | None = None
    event_diff_threshold: float | None = None
    vlm_dispatch_cooldown_sec: float | None = None
    target_fps: int | None = None
    adaptive_fps_enabled: bool | None = None
    max_target_fps: int | None = None
    adaptive_fps_cooldown_sec: float | None = None
    fusion_enabled: bool | None = None
    fusion_correlation_window_sec: float | None = None
    fusion_flush_delay_sec: float | None = None


class DetectionTemplateIn(BaseModel):
    """A user-saved Detection Tuning preset - any subset of the same fields
    as DetectionConfigIn, so a template can tune just a couple of knobs."""
    values: DetectionConfigIn


class CameraSeverityIn(BaseModel):
    # None/omitted clears the override so the camera reverts to using the
    # VLM's own severity assessment.
    severity: str | None = None


class ConstraintIn(BaseModel):
    classes: list[str] = []
    days: list[str] = []
    start_time: str | None = None
    end_time: str | None = None
    note: str | None = None


class ConstraintsIn(BaseModel):
    constraints: list[ConstraintIn]


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}{'*' * (len(key) - 8)}{key[-4:]}"


# --- Cameras -----------------------------------------------------------

@app.get("/api/cameras")
def list_cameras():
    return {"cameras": config.CAMERAS}


@app.post("/api/cameras")
def upsert_camera(cam: CameraIn):
    existing = next((c for c in config.CAMERAS if c["id"] == cam.id), None)
    if existing:
        existing["source"] = cam.source
    else:
        config.CAMERAS.append({"id": cam.id, "source": cam.source})
    save_config_overrides(config)
    return {"ok": True, "cameras": config.CAMERAS}


@app.delete("/api/cameras/{camera_id}")
def delete_camera(camera_id: str):
    config.CAMERAS = [c for c in config.CAMERAS if c["id"] != camera_id]
    save_config_overrides(config)
    shared_state.drop_ingest_queue(camera_id)
    return {"ok": True, "cameras": config.CAMERAS}


# --- Rules (Natural Language Rules Engine) ------------------------------

@app.get("/api/rules")
def list_rules():
    camera_rules = {}
    for cam in config.CAMERAS:
        cid = cam["id"]
        camera_rules[cid] = _rules_engine.get_rule(cid) if _rules_engine else config.CAMERA_RULES.get(cid, config.DEFAULT_RULE)
    return {"default_rule": config.DEFAULT_RULE, "camera_rules": camera_rules}


@app.put("/api/rules/default")
def update_default_rule(body: RuleIn):
    config.DEFAULT_RULE = body.rule
    save_config_overrides(config)
    return {"ok": True}


@app.put("/api/rules/{camera_id}")
def update_rule(camera_id: str, body: RuleIn):
    if _rules_engine is not None:
        _rules_engine.set_rule(camera_id, body.rule)
    config.CAMERA_RULES[camera_id] = body.rule
    save_config_overrides(config)
    return {"ok": True}


@app.get("/api/detection-classes")
def list_detection_classes():
    """Object classes the Gatekeeper (YOLO) currently watches for - used to
    populate the Rule Builder's object-type picker in the dashboard."""
    return {"classes": sorted(config.COCO_CLASS_NAMES.values())}


@app.get("/api/rules/{camera_id}/constraints")
def get_rule_constraints(camera_id: str):
    constraints = (
        _rules_engine.get_constraints(camera_id) if _rules_engine is not None
        else config.CAMERA_RULE_CONSTRAINTS.get(camera_id, [])
    )
    return {"constraints": constraints}


@app.put("/api/rules/{camera_id}/constraints")
def update_rule_constraints(camera_id: str, body: ConstraintsIn):
    constraints = [c.model_dump() for c in body.constraints]
    if _rules_engine is not None:
        _rules_engine.set_constraints(camera_id, constraints)
    config.CAMERA_RULE_CONSTRAINTS[camera_id] = constraints
    save_config_overrides(config)
    return {"ok": True, "constraints": constraints}


# --- Alert Routing Config -----------------------------------------------

@app.get("/api/alerts/config")
def get_alert_config():
    return {
        "channels": sorted(config.ALERT_CHANNELS),
        "min_severity": config.ALERT_MIN_SEVERITY,
        "severity_levels": config.SEVERITY_LEVELS,
        "slack_webhook_url": config.SLACK_WEBHOOK_URL,
        "generic_webhook_url": config.GENERIC_WEBHOOK_URL,
        "sms_to": config.ALERT_SMS_TO,
        "twilio_account_sid": config.TWILIO_ACCOUNT_SID,
        "twilio_from_number": config.TWILIO_FROM_NUMBER,
        "has_twilio_auth_token": bool(config.TWILIO_AUTH_TOKEN),
        "twilio_auth_token_preview": _mask_key(config.TWILIO_AUTH_TOKEN),
        "has_pagerduty_key": bool(config.PAGERDUTY_ROUTING_KEY),
        "pagerduty_key_preview": _mask_key(config.PAGERDUTY_ROUTING_KEY),
    }


@app.put("/api/alerts/config")
def update_alert_config(body: AlertConfigIn):
    if body.channels is not None:
        config.ALERT_CHANNELS = set(body.channels)
    if body.min_severity is not None:
        config.ALERT_MIN_SEVERITY.update(body.min_severity)
    if body.slack_webhook_url is not None:
        config.SLACK_WEBHOOK_URL = body.slack_webhook_url
    if body.generic_webhook_url is not None:
        config.GENERIC_WEBHOOK_URL = body.generic_webhook_url
    if body.twilio_account_sid is not None:
        config.TWILIO_ACCOUNT_SID = body.twilio_account_sid
    if body.twilio_auth_token is not None:
        config.TWILIO_AUTH_TOKEN = body.twilio_auth_token
    if body.twilio_from_number is not None:
        config.TWILIO_FROM_NUMBER = body.twilio_from_number
    if body.sms_to is not None:
        config.ALERT_SMS_TO = body.sms_to
    if body.pagerduty_routing_key is not None:
        config.PAGERDUTY_ROUTING_KEY = body.pagerduty_routing_key
    save_config_overrides(config)
    return {"ok": True}


# --- LLM / VLM API Key --------------------------------------------------

@app.get("/api/llm/config")
def get_llm_config():
    return {
        "has_key": bool(config.GROQ_API_KEY),
        "key_preview": _mask_key(config.GROQ_API_KEY),
        "model": config.VLM_MODEL,
    }


@app.put("/api/llm/config")
def update_llm_config(body: LLMConfigIn):
    api_key = body.api_key.strip() if body.api_key else ""
    if not api_key and not body.model:
        raise HTTPException(status_code=400, detail="Provide an API key or a model to update.")
    if api_key:
        config.GROQ_API_KEY = api_key
        if _vlm_client is not None:
            _vlm_client.update_api_key(api_key)
    if body.model:
        config.VLM_MODEL = body.model
    save_config_overrides(config)
    return {
        "ok": True,
        "has_key": bool(config.GROQ_API_KEY),
        "key_preview": _mask_key(config.GROQ_API_KEY),
        "model": config.VLM_MODEL,
    }


# --- Incident Media (photos/clips) --------------------------------------

@app.get("/api/media/config")
def get_media_config():
    return {
        "save_media": config.SAVE_INCIDENT_MEDIA,
        "save_photos": config.SAVE_INCIDENT_PHOTOS,
        "save_videos": config.SAVE_INCIDENT_VIDEOS,
    }


@app.put("/api/media/config")
def update_media_config(body: MediaConfigIn):
    if body.save_media is not None:
        config.SAVE_INCIDENT_MEDIA = body.save_media
    if body.save_photos is not None:
        config.SAVE_INCIDENT_PHOTOS = body.save_photos
    if body.save_videos is not None:
        config.SAVE_INCIDENT_VIDEOS = body.save_videos
    save_config_overrides(config)
    return {
        "ok": True,
        "save_media": config.SAVE_INCIDENT_MEDIA,
        "save_photos": config.SAVE_INCIDENT_PHOTOS,
        "save_videos": config.SAVE_INCIDENT_VIDEOS,
    }


# --- Detection Tuning ----------------------------------------------------
# Surfaces the gatekeeper/motion/fusion tunables (normally only set via
# config.py/env vars) on the dashboard, so operators can adjust sensitivity
# per-deployment - e.g. a busy shop entrance needs different thresholds than
# a quiet home driveway - and apply the "template" presets below.

def _detection_config_dict():
    return {
        "motion_threshold": config.MOTION_THRESHOLD,
        "adaptive_motion_enabled": config.ADAPTIVE_MOTION_ENABLED,
        "motion_threshold_min": config.MOTION_THRESHOLD_MIN,
        "motion_threshold_max": config.MOTION_THRESHOLD_MAX,
        "confidence_threshold": config.CONFIDENCE_THRESHOLD,
        "min_detection_area_ratio": config.MIN_DETECTION_AREA_RATIO,
        "track_cooldown_sec": config.TRACK_COOLDOWN_SEC,
        "track_stale_sec": config.TRACK_STALE_SEC,
        "spatial_dedup_enabled": config.SPATIAL_DEDUP_ENABLED,
        "spatial_dedup_iou_threshold": config.SPATIAL_DEDUP_IOU_THRESHOLD,
        "event_diff_enabled": config.EVENT_DIFF_ENABLED,
        "event_diff_threshold": config.EVENT_DIFF_THRESHOLD,
        "vlm_dispatch_cooldown_sec": config.VLM_DISPATCH_COOLDOWN_SEC,
        "target_fps": config.TARGET_FPS,
        "adaptive_fps_enabled": config.ADAPTIVE_FPS_ENABLED,
        "max_target_fps": config.MAX_TARGET_FPS,
        "adaptive_fps_cooldown_sec": config.ADAPTIVE_FPS_COOLDOWN_SEC,
        "fusion_enabled": config.FUSION_ENABLED,
        "fusion_correlation_window_sec": config.FUSION_CORRELATION_WINDOW_SEC,
        "fusion_flush_delay_sec": config.FUSION_FLUSH_DELAY_SEC,
    }


@app.get("/api/detection/config")
def get_detection_config():
    return _detection_config_dict()


@app.put("/api/detection/config")
def update_detection_config(body: DetectionConfigIn):
    field_map = {
        "motion_threshold": "MOTION_THRESHOLD",
        "adaptive_motion_enabled": "ADAPTIVE_MOTION_ENABLED",
        "motion_threshold_min": "MOTION_THRESHOLD_MIN",
        "motion_threshold_max": "MOTION_THRESHOLD_MAX",
        "confidence_threshold": "CONFIDENCE_THRESHOLD",
        "min_detection_area_ratio": "MIN_DETECTION_AREA_RATIO",
        "track_cooldown_sec": "TRACK_COOLDOWN_SEC",
        "track_stale_sec": "TRACK_STALE_SEC",
        "spatial_dedup_enabled": "SPATIAL_DEDUP_ENABLED",
        "spatial_dedup_iou_threshold": "SPATIAL_DEDUP_IOU_THRESHOLD",
        "event_diff_enabled": "EVENT_DIFF_ENABLED",
        "event_diff_threshold": "EVENT_DIFF_THRESHOLD",
        "vlm_dispatch_cooldown_sec": "VLM_DISPATCH_COOLDOWN_SEC",
        "target_fps": "TARGET_FPS",
        "adaptive_fps_enabled": "ADAPTIVE_FPS_ENABLED",
        "max_target_fps": "MAX_TARGET_FPS",
        "adaptive_fps_cooldown_sec": "ADAPTIVE_FPS_COOLDOWN_SEC",
        "fusion_enabled": "FUSION_ENABLED",
        "fusion_correlation_window_sec": "FUSION_CORRELATION_WINDOW_SEC",
        "fusion_flush_delay_sec": "FUSION_FLUSH_DELAY_SEC",
    }
    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    for key, value in updates.items():
        setattr(config, field_map[key], value)
    if updates:
        save_config_overrides(config)
    return {"ok": True, **_detection_config_dict()}


# --- Custom Detection Tuning Templates ------------------------------------
# In addition to the dashboard's built-in Home/Shop/Warehouse/Office presets,
# operators can save their own named tuning presets (any subset of the
# Detection Tuning fields) and apply/attach them to specific cameras.

@app.get("/api/detection/templates")
def list_detection_templates():
    return {"templates": config.CUSTOM_DETECTION_TEMPLATES}


@app.put("/api/detection/templates/{name}")
def upsert_detection_template(name: str, body: DetectionTemplateIn):
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Template name is required.")
    values = body.values.model_dump(exclude_unset=True, exclude_none=True)
    if not values:
        raise HTTPException(status_code=400, detail="Template must include at least one setting.")
    config.CUSTOM_DETECTION_TEMPLATES[name] = values
    save_config_overrides(config)
    return {"ok": True, "templates": config.CUSTOM_DETECTION_TEMPLATES}


@app.delete("/api/detection/templates/{name}")
def delete_detection_template(name: str):
    config.CUSTOM_DETECTION_TEMPLATES.pop(name, None)
    save_config_overrides(config)
    return {"ok": True, "templates": config.CUSTOM_DETECTION_TEMPLATES}


# --- Per-Camera Detection Tuning Overrides ---------------------------------
# Lets a specific camera run "hotter" or "cooler" than the global default
# (or have a template attached to it) without affecting every other camera.

@app.get("/api/detection/config/{camera_id}")
def get_camera_detection_config(camera_id: str):
    overrides = config.CAMERA_DETECTION_OVERRIDES.get(camera_id, {})
    effective = {
        key: camera_setting(config, camera_id, key)
        for key in _DETECTION_CONFIG_FIELDS
    }
    return {"effective": effective, "overrides": overrides}


@app.put("/api/detection/config/{camera_id}")
def update_camera_detection_config(camera_id: str, body: DetectionConfigIn):
    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    if updates:
        overrides = config.CAMERA_DETECTION_OVERRIDES.setdefault(camera_id, {})
        overrides.update(updates)
        save_config_overrides(config)
    overrides = config.CAMERA_DETECTION_OVERRIDES.get(camera_id, {})
    effective = {
        key: camera_setting(config, camera_id, key)
        for key in _DETECTION_CONFIG_FIELDS
    }
    return {"ok": True, "effective": effective, "overrides": overrides}


@app.delete("/api/detection/config/{camera_id}")
def clear_camera_detection_config(camera_id: str):
    """Reverts a camera to the global Detection Tuning defaults."""
    config.CAMERA_DETECTION_OVERRIDES.pop(camera_id, None)
    save_config_overrides(config)
    effective = {
        key: camera_setting(config, camera_id, key)
        for key in _DETECTION_CONFIG_FIELDS
    }
    return {"ok": True, "effective": effective, "overrides": {}}


# --- Per-Camera Severity Override -----------------------------------------
# Forces every incident from a given camera to a fixed severity level (e.g.
# "camera 1 -> always critical"), instead of relying on the VLM's assessment.

@app.get("/api/cameras/{camera_id}/severity")
def get_camera_severity_override(camera_id: str):
    return {
        "severity": config.CAMERA_SEVERITY_OVERRIDE.get(camera_id),
        "severity_levels": config.SEVERITY_LEVELS,
    }


@app.put("/api/cameras/{camera_id}/severity")
def update_camera_severity_override(camera_id: str, body: CameraSeverityIn):
    if body.severity:
        if body.severity not in config.SEVERITY_LEVELS:
            raise HTTPException(status_code=400, detail=f"Unknown severity level: {body.severity}")
        config.CAMERA_SEVERITY_OVERRIDE[camera_id] = body.severity
    else:
        config.CAMERA_SEVERITY_OVERRIDE.pop(camera_id, None)
    save_config_overrides(config)
    return {"ok": True, "severity": config.CAMERA_SEVERITY_OVERRIDE.get(camera_id)}



# --- Incidents + Live Streaming -----------------------------------------

@app.get("/api/incidents")
def get_incidents(limit: int = 50):
    return {"incidents": list(shared_state.incidents)[:limit]}


@app.get("/api/stream/{camera_id}")
async def stream_camera(camera_id: str):
    async def gen():
        boundary = b"--frame"
        while True:
            frame = shared_state.latest_frames.get(camera_id)
            if frame is not None:
                yield boundary + b"\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            await asyncio.sleep(0.2)  # ~5 FPS live view is plenty for a security dashboard

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/api/stream/{camera_id}/snapshot")
async def stream_snapshot(camera_id: str):
    """
    Single latest JPEG frame for one camera. The dashboard polls this on a
    short interval (see lib/api.ts snapshotUrl) instead of relying on the
    multipart MJPEG stream above, since some browsers/proxies buffer or only
    render the first part of a `multipart/x-mixed-replace` response - which
    looked like the live view was frozen on the very first frame. Polling a
    plain image endpoint is far more reliable across environments.
    """
    frame = shared_state.latest_frames.get(camera_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="No frame available yet")
    return Response(
        content=frame,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


@app.post("/api/ingest/{camera_id}")
async def ingest_frame(camera_id: str, request: Request):
    """
    Receives one JPEG frame captured client-side (e.g. the operator's laptop
    or phone webcam via getUserMedia, since the backend process itself has no
    access to that hardware). The camera's CAMERAS entry must have source set
    to the "browser" sentinel so run_browser_camera_pipeline (main.py) knows
    to consume frames from this queue instead of cv2.VideoCapture.
    """
    try:
        body = await request.body()
    except ClientDisconnect:
        # Browser aborted the upload mid-request (tab closed, page navigated,
        # or a new frame superseded this one before it finished sending).
        # Nothing to do - just drop it silently instead of a 500.
        return Response(status_code=499)
    if not body:
        raise HTTPException(status_code=400, detail="Empty frame body")
    shared_state.push_ingested_frame(camera_id, body)
    return {"ok": True}


@app.websocket("/ws/incidents")
async def ws_incidents(websocket: WebSocket):
    await websocket.accept()
    queue = shared_state.subscribe()
    try:
        while True:
            incident = await queue.get()
            await websocket.send_text(json.dumps(incident, default=str))
    except WebSocketDisconnect:
        pass
    finally:
        shared_state.unsubscribe(queue)
