import os
import json
from dataclasses import dataclass, field

@dataclass
class Config:
    # Video & sampling
    VIDEO_SOURCE: str = os.getenv("VIDEO_SOURCE", "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")  # RTSP URL, video path, or webcam ID
    TARGET_FPS: int = 1                                 # Baseline/idle sampling rate
    ORIGINAL_FPS: int = 30                              # Fallback if unreadable from stream

    # Dashboard Live View: the analysis pipeline above intentionally downsamples
    # to TARGET_FPS (as low as 1 FPS at idle) to save YOLO/VLM compute - but the
    # camera tiles in the dashboard should still look like smooth live video, not
    # a slideshow. LIVE_VIEW_FPS is a SEPARATE, independent publish rate used only
    # for the dashboard's MJPEG/snapshot preview, decoupled from analysis tiering.
    LIVE_VIEW_FPS: int = 12

    # Dashboard API (FastAPI/uvicorn) - serves live camera streams, config
    # CRUD, and the WebSocket incident feed consumed by the Next.js dashboard.
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.getenv("API_PORT", "8000"))

    # Multi-Camera Fusion: list of independent camera feeds to ingest concurrently.
    # Each entry needs a unique "id" (used for rules/timelines/logging) and a "source"
    # (RTSP URL, file path, or webcam index). Defaults to a single camera backed by
    # VIDEO_SOURCE so existing single-camera setups keep working unchanged.
    CAMERAS: list[dict] = field(default_factory=lambda: [
        {"id": "default", "source": os.getenv("VIDEO_SOURCE", "sample.mp4")}
    ])

    FUSION_ENABLED: bool = True
    # Events from different cameras that land within this rolling window of each
    # other are treated as one correlated incident (e.g. a person seen on the
    # driveway camera and moments later on the porch camera).
    FUSION_CORRELATION_WINDOW_SEC: float = 8.0
    # Grace period to wait for additional correlated events before dispatching
    # the fused incident to the alerting layer.
    FUSION_FLUSH_DELAY_SEC: float = 3.0

    # Adaptive Tiering: dynamically raise sampling rate when the scene is active,
    # and relax back down to TARGET_FPS when the scene is quiet.
    ADAPTIVE_FPS_ENABLED: bool = True
    MAX_TARGET_FPS: int = 5                             # Ceiling used when motion is currently elevated
    ADAPTIVE_FPS_COOLDOWN_SEC: float = 5.0               # Time of inactivity before falling back to TARGET_FPS

    # Motion threshold
    # Percentage of pixels that must change to trigger the semantic check.
    # This is now used as the initial/fallback value; see adaptive settings below.
    MOTION_THRESHOLD: float = 2.5

    # Adaptive Tiering: auto-tune the effective motion threshold per-camera based on
    # the rolling noise floor of the scene (e.g. windy trees vs. a static indoor hallway),
    # instead of relying on one static global threshold.
    ADAPTIVE_MOTION_ENABLED: bool = True
    MOTION_BASELINE_WINDOW: int = 60                    # Rolling samples used to estimate scene noise
    MOTION_ADAPTIVE_STDDEV_MULTIPLIER: float = 3.0       # Effective threshold = mean + K * stddev
    MOTION_THRESHOLD_MIN: float = 1.0                    # Never adapt below this (stay sensitive)
    MOTION_THRESHOLD_MAX: float = 15.0                   # Never adapt above this (stay usable)

    # Semantic gating
    YOLO_MODEL: str = "yolov8n.pt"                      # Nano model for edge optimization
    CONFIDENCE_THRESHOLD: float = 0.75
    # Target classes based on COCO dataset. Broadened beyond the original
    # person/car/motorcycle set so common household/rule scenarios (e.g.
    # "alert on dogs after 4pm", "alert on unattended bags") are detectable
    # out of the box. Customizable from the dashboard (Configuration > Rules).
    TARGET_CLASSES: set[int] = field(default_factory=lambda: {0, 1, 2, 3, 5, 7, 15, 16, 24, 26, 28})
    COCO_CLASS_NAMES: dict[int, str] = field(default_factory=lambda: {
        0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck",
        15: "cat", 16: "dog", 24: "backpack", 26: "handbag", 28: "suitcase",
    })

    # Re-identification / tracking
    # Uses YOLO's built-in multi-object tracker so a single lingering/loitering
    # subject is treated as ONE ongoing event instead of re-triggering repeatedly.
    TRACKER: str = "bytetrack.yaml"
    TRACK_COOLDOWN_SEC: float = 60.0                    # Suppress re-triggering the same track ID within this window
    TRACK_STALE_SEC: float = 30.0                       # Forget a track ID if it hasn't been seen in this long

    # Backstop for when the tracker itself fails to keep a stable ID for a
    # subject that hasn't actually left (common at low sampling FPS, or after
    # brief occlusion) - without this, an ID "churn" event bypasses
    # TRACK_COOLDOWN_SEC entirely and fires a fresh VLM call for what is
    # still the same physical person/object. Any new track ID (or untracked
    # detection) is compared against recently-triggered boxes of the same
    # class; if it overlaps closely enough with one still inside its cooldown
    # window, it's treated as the same subject and suppressed instead of
    # starting a new event.
    SPATIAL_DEDUP_ENABLED: bool = True
    SPATIAL_DEDUP_IOU_THRESHOLD: float = 0.3            # Min IoU with a recent same-class box to count as "same subject"

    # Distance approximation / far-field suppression
    # Cameras aimed at a road or open area otherwise trigger a VLM call for
    # every distant car or pedestrian passing through the far background.
    # There's no depth sensor, so distance is approximated from the detected
    # bounding box's area relative to the full frame - a subject far from the
    # camera occupies a much smaller fraction of the frame than one nearby.
    # A detection whose box-area ratio falls below the threshold is treated as
    # "too far to matter" and is dropped before it can start/extend an event,
    # cutting down on unnecessary API calls. 0 disables the filter entirely.
    MIN_DETECTION_AREA_RATIO: float = 0.0
    # Optional per-class overrides (keyed by COCO class name), since e.g. a car
    # is physically much larger than a person and so appears "big enough" from
    # farther away. Falls back to MIN_DETECTION_AREA_RATIO when a class isn't
    # listed here.
    MIN_DETECTION_AREA_RATIO_BY_CLASS: dict[str, float] = field(default_factory=dict)

    # Context Buffering
    # 5 seconds pre-trigger and 5 seconds post-trigger at TARGET_FPS
    BUFFER_SIZE_FRAMES: int = 5

    # Final diff-match gate: right before a captured event is sent to the cloud
    # VLM, compare frames spread across the whole event buffer (pre + post
    # trigger) and only dispatch if the max structural change between any two
    # of them clears this threshold. Filters out gatekeeper triggers where the
    # scene never meaningfully changed (e.g. an already-stationary subject).
    EVENT_DIFF_ENABLED: bool = True
    EVENT_DIFF_THRESHOLD: float = 80.0  # percentage of changed pixels

    # Cloud VLM integration
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    VLM_MODEL: str = "meta-llama/llama-4-scout-17b-16e-instruct"
    # Rate limiting for cloud VLM calls: without this, a noisy scene (or a
    # tracker repeatedly failing to keep a stable ID) can fire a fresh Groq
    # request on almost every trigger. VLM_DISPATCH_COOLDOWN_SEC enforces a
    # minimum gap between two dispatches on the SAME camera (independent of
    # per-track dedup below), and VLM_MAX_CONCURRENT_REQUESTS caps how many
    # VLM calls may be in-flight at once across ALL cameras.
    VLM_DISPATCH_COOLDOWN_SEC: float = 3.0
    VLM_MAX_CONCURRENT_REQUESTS: int = 2

    # Natural Language Rules Engine
    # Each camera can be configured with a plain-English rule describing what
    # counts as an alertable incident. The rule text is injected directly into
    # the VLM prompt (prompt templating) rather than hand-parsed, letting the
    # model itself judge whether the observed event matches the operator's intent.
    # Keyed by camera "id" from CAMERAS above; falls back to DEFAULT_RULE.
    DEFAULT_RULE: str = os.getenv(
        "DEFAULT_RULE",
        "Alert on any person, car, or motorcycle detected in view (matching just one of these is sufficient)."
    )
    CAMERA_RULES: dict[str, str] = field(default_factory=lambda: {
        # "front_door": "Alert me only if a person is at the front door after "
        #               "10pm and is not wearing a delivery uniform.",
    })

    # Structured Rule Constraints: a hard, non-AI pre-filter layered on top of
    # the free-text rule above. Each camera maps to a list of constraints;
    # an event is only escalated to the VLM if it matches AT LEAST ONE
    # constraint (OR across the list). Within a single constraint, all set
    # fields must match (AND) - e.g. classes=["dog"] + start_time="16:00" means
    # "a dog, and only after 4pm". An empty list means "no hard constraint,
    # rely on the free-text rule alone" (the legacy behavior).
    #   {
    #     "classes": ["dog"],            # COCO class names; empty/omitted = any
    #     "days": ["mon", "tue"],         # 3-letter lowercase day codes; empty = every day
    #     "start_time": "16:00",          # "HH:MM" 24h; empty = no lower bound
    #     "end_time": "23:59",            # "HH:MM" 24h; supports overnight wraparound
    #     "note": "free-text hint forwarded to the VLM prompt",
    #   }
    CAMERA_RULE_CONSTRAINTS: dict[str, list[dict]] = field(default_factory=dict)

    # Multi-Modal Alert Routing
    # Structured incident reports (severity, entities, bounding boxes, summary) are
    # dispatched to one or more channels depending on configured severity thresholds.
    # "in_app" pushes the incident to the dashboard's WebSocket feed, which drives
    # a toast + severity-based sound/haptics in the Next.js UI.
    ALERT_CHANNELS: set[str] = field(default_factory=lambda: {"in_app", "slack", "webhook"})
    ALERT_MIN_SEVERITY: dict[str, str] = field(default_factory=lambda: {
        "in_app": "low",
        "slack": "low",
        "webhook": "low",
        "sms": "high",
        "pagerduty": "critical",
    })
    SEVERITY_LEVELS: list[str] = field(default_factory=lambda: ["low", "medium", "high", "critical"])

    SLACK_WEBHOOK_URL: str = os.getenv("SLACK_WEBHOOK_URL", "")
    GENERIC_WEBHOOK_URL: str = os.getenv("GENERIC_WEBHOOK_URL", "")

    TWILIO_ACCOUNT_SID: str = os.getenv("TWILIO_ACCOUNT_SID", "")
    TWILIO_AUTH_TOKEN: str = os.getenv("TWILIO_AUTH_TOKEN", "")
    TWILIO_FROM_NUMBER: str = os.getenv("TWILIO_FROM_NUMBER", "")
    ALERT_SMS_TO: str = os.getenv("ALERT_SMS_TO", "")

    PAGERDUTY_ROUTING_KEY: str = os.getenv("PAGERDUTY_ROUTING_KEY", "")

    # Incident Media Capture: when enabled, a snapshot photo (the sharpest
    # trigger-adjacent frame) and a short MP4 clip of the full event buffer
    # (pre + post trigger context) are saved to disk for every dispatched
    # incident, and served back to the dashboard via /media/*.
    SAVE_INCIDENT_MEDIA: bool = False
    SAVE_INCIDENT_PHOTOS: bool = True
    SAVE_INCIDENT_VIDEOS: bool = True
    MEDIA_DIR: str = os.getenv("MEDIA_DIR", "media")
    MEDIA_VIDEO_FPS: int = 5

    # Per-camera Detection Tuning overrides: keyed by camera "id", each maps
    # to a partial dict of the same fields exposed on the dashboard's
    # Detection Tuning tab (see _DETECTION_CONFIG_FIELDS below). A camera
    # without an entry (or a field missing from its entry) falls back to the
    # global default above - so a shop's front counter camera can run "hot"
    # while a quiet back-office camera stays on defaults, without maintaining
    # a second full config.
    CAMERA_DETECTION_OVERRIDES: dict[str, dict] = field(default_factory=dict)

    # User-saved Detection Tuning templates (name -> partial field dict, same
    # shape as one CAMERA_DETECTION_OVERRIDES entry), in addition to the
    # built-in Home/Shop/Warehouse/Office presets defined in the dashboard.
    CUSTOM_DETECTION_TEMPLATES: dict[str, dict] = field(default_factory=dict)

    # Per-camera severity override: forces every incident from this camera to
    # the given severity level (e.g. "camera 1 -> always critical"), instead
    # of relying on the VLM's own assessment. Keyed by camera "id"; a camera
    # with no entry uses the VLM-assigned severity unchanged.
    CAMERA_SEVERITY_OVERRIDE: dict[str, str] = field(default_factory=dict)


# Maps the Detection Tuning dashboard's field names to this Config class's
# attribute names, so per-camera overrides and the /api/detection/config
# endpoints can resolve either name generically instead of a long if/elif chain.
_DETECTION_CONFIG_FIELDS = {
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
}


def camera_setting(cfg: "Config", camera_id: str | None, key: str):
    """Effective value of one Detection Tuning field for a specific camera:
    a per-camera override if set (config.CAMERA_DETECTION_OVERRIDES), else
    the global default. `key` is the dashboard's snake_case field name (see
    _DETECTION_CONFIG_FIELDS)."""
    attr = _DETECTION_CONFIG_FIELDS[key]
    if camera_id:
        override = cfg.CAMERA_DETECTION_OVERRIDES.get(camera_id, {})
        if key in override:
            return override[key]
    return getattr(cfg, attr)


# --- Runtime overrides persistence -----------------------------------------
# Lets the dashboard's Configuration page edit cameras/rules/alert settings at
# runtime and have them survive a process restart, without touching the
# hardcoded dataclass defaults or requiring env var changes.
CONFIG_OVERRIDES_PATH = os.getenv("CONFIG_OVERRIDES_PATH", "runtime_config.json")

_OVERRIDABLE_FIELDS = [
    "CAMERAS", "DEFAULT_RULE", "CAMERA_RULES", "CAMERA_RULE_CONSTRAINTS",
    "ALERT_CHANNELS", "ALERT_MIN_SEVERITY",
    "SLACK_WEBHOOK_URL", "GENERIC_WEBHOOK_URL",
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "ALERT_SMS_TO",
    "PAGERDUTY_ROUTING_KEY",
    "MOTION_THRESHOLD", "TARGET_FPS", "CONFIDENCE_THRESHOLD",
    "GROQ_API_KEY", "VLM_MODEL", "TARGET_CLASSES",
    "VLM_DISPATCH_COOLDOWN_SEC", "VLM_MAX_CONCURRENT_REQUESTS",
    "EVENT_DIFF_ENABLED", "EVENT_DIFF_THRESHOLD",
    "LIVE_VIEW_FPS",
    "SAVE_INCIDENT_MEDIA", "SAVE_INCIDENT_PHOTOS", "SAVE_INCIDENT_VIDEOS",
    "MEDIA_VIDEO_FPS",
    "MIN_DETECTION_AREA_RATIO", "MIN_DETECTION_AREA_RATIO_BY_CLASS",
    # Detection tuning knobs surfaced on the dashboard's Configuration >
    # Detection Tuning panel, so operators can adjust sensitivity/cooldowns
    # per-deployment (home, shop, warehouse, etc.) without editing this file.
    "ADAPTIVE_MOTION_ENABLED", "MOTION_BASELINE_WINDOW",
    "MOTION_ADAPTIVE_STDDEV_MULTIPLIER", "MOTION_THRESHOLD_MIN", "MOTION_THRESHOLD_MAX",
    "TRACK_COOLDOWN_SEC", "TRACK_STALE_SEC",
    "SPATIAL_DEDUP_ENABLED", "SPATIAL_DEDUP_IOU_THRESHOLD",
    "ADAPTIVE_FPS_ENABLED", "MAX_TARGET_FPS", "ADAPTIVE_FPS_COOLDOWN_SEC",
    "FUSION_ENABLED", "FUSION_CORRELATION_WINDOW_SEC", "FUSION_FLUSH_DELAY_SEC",
    "CAMERA_DETECTION_OVERRIDES", "CUSTOM_DETECTION_TEMPLATES", "CAMERA_SEVERITY_OVERRIDE",
]

# Fields that are Python `set`s on the dataclass but must round-trip through
# JSON as sorted lists.
_SET_FIELDS = {"ALERT_CHANNELS", "TARGET_CLASSES"}


def load_config_overrides(cfg: "Config"):
    """Applies any previously saved dashboard edits on top of the defaults."""
    if not os.path.exists(CONFIG_OVERRIDES_PATH):
        return
    try:
        with open(CONFIG_OVERRIDES_PATH) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return
    for key, value in data.items():
        if key not in _OVERRIDABLE_FIELDS:
            continue
        if key in _SET_FIELDS:
            value = set(value)
        setattr(cfg, key, value)


def save_config_overrides(cfg: "Config"):
    """Persists the current values of dashboard-editable fields to disk."""
    data = {}
    for key in _OVERRIDABLE_FIELDS:
        value = getattr(cfg, key)
        if isinstance(value, set):
            value = sorted(value)
        data[key] = value
    with open(CONFIG_OVERRIDES_PATH, "w") as f:
        json.dump(data, f, indent=2)


config = Config()
load_config_overrides(config)