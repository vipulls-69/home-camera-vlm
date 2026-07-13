import json
import time
import datetime
import dataclasses
import cv2
import numpy as np
import asyncio
from config import config, camera_setting
from video_processor import VideoProcessor
from gatekeeper import Gatekeeper
from vlm_client import VLMClient
from alerting import AlertDispatcher
from rules import RulesEngine
from fusion import FusionEngine
from shared_state import shared_state
from media_store import save_incident_media
from api_server import bind_rules_engine, bind_vlm_client

# Delay before the camera manager restarts a stream that ended or failed.
RECONNECT_DELAY_SEC = 5.0

# CAMERAS[].source value for feeds pushed from the browser (laptop/phone
# webcam via getUserMedia) to POST /api/ingest/{id}, rather than pulled
# locally via cv2.VideoCapture.
BROWSER_SOURCE = "browser"
# Timeout before a browser-pushed feed is treated as disconnected.
BROWSER_FRAME_TIMEOUT_SEC = 15.0


def _encode_frame_for_stream(frame) -> bytes:
    """Downscale and JPEG-encode a frame for the MJPEG live view."""
    h, w = frame.shape[:2]
    if w > 640:
        scale = 640 / w
        frame = cv2.resize(frame, (640, int(h * scale)))
    _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return buffer.tobytes()


async def run_camera_pipeline(
    camera_id: str,
    video_source: str,
    vlm: VLMClient,
    rules_engine: RulesEngine,
    fusion_engine: FusionEngine,
    pending_tasks: list,
    vlm_semaphore: asyncio.Semaphore,
):
    """Run one camera's ingestion, pruning and gatekeeper state machine.
    One instance runs per entry in config.CAMERAS, sharing the VLM client,
    rules engine and fusion engine so events across cameras can be correlated."""
    processor = VideoProcessor(camera_id)
    gatekeeper = Gatekeeper(camera_id)

    cap = cv2.VideoCapture(video_source)
    if not cap.isOpened():
        print(f"[{camera_id}] Failed to open video source: {video_source}. Will retry.")
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    actual_fps = fps if fps > 0 else config.ORIGINAL_FPS
    frame_skip = max(1, int(actual_fps / config.TARGET_FPS))
    # Higher, independent publish rate for the live view so the preview stays
    # smooth regardless of the analysis sampling rate.
    live_view_skip = max(1, int(actual_fps / config.LIVE_VIEW_FPS))

    frame_count = 0
    state = _new_event_state()

    print(f"[{camera_id}] Pipeline active. Downsampling {actual_fps} FPS to {config.TARGET_FPS} FPS "
          f"(adaptive ceiling: {config.MAX_TARGET_FPS} FPS). Live view at ~{config.LIVE_VIEW_FPS} FPS. "
          f"Rule: \"{rules_engine.get_rule(camera_id)}\"")

    # Pace reads to the source frame rate and yield to the event loop each
    # frame, so file sources play at normal speed and the API stays responsive.
    frame_interval_sec = 1.0 / actual_fps if actual_fps > 0 else 1.0 / 30
    last_frame_time = time.monotonic()

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print(f"[{camera_id}] Stream disconnected or EOF reached.")
                break

            frame_count += 1

            # Publish to the live view at its own rate, decoupled from analysis.
            if frame_count % live_view_skip == 0:
                shared_state.update_frame(camera_id, _encode_frame_for_stream(frame))

            elapsed = time.monotonic() - last_frame_time
            await asyncio.sleep(max(0.0, frame_interval_sec - elapsed))
            last_frame_time = time.monotonic()

            # Tier 1: temporal pruning. The sampling rate tightens when the
            # scene is active and relaxes to TARGET_FPS when quiet.
            current_target_fps = processor.get_target_fps()
            frame_skip = max(1, int(actual_fps / current_target_fps))
            if frame_count % frame_skip != 0:
                continue

            processor.update_buffer(frame)

            await _process_frame(
                camera_id, frame, processor, gatekeeper, rules_engine, fusion_engine,
                vlm, vlm_semaphore, pending_tasks, state,
            )

    finally:
        cap.release()


async def run_browser_camera_pipeline(
    camera_id: str,
    vlm: VLMClient,
    rules_engine: RulesEngine,
    fusion_engine: FusionEngine,
    pending_tasks: list,
    vlm_semaphore: asyncio.Semaphore,
):
    """
    Same pipeline as run_camera_pipeline, but frames arrive by being POSTed
    (as JPEG bytes) to /api/ingest/{camera_id} from the browser, since the
    backend has no direct access to that hardware. Frames are read from the
    shared ingestion queue instead of cv2.VideoCapture.
    """
    processor = VideoProcessor(camera_id)
    gatekeeper = Gatekeeper(camera_id)
    queue = shared_state.get_ingest_queue(camera_id)
    state = _new_event_state()

    print(f"[{camera_id}] Browser-webcam pipeline active, waiting for frames from the dashboard... "
          f"Rule: \"{rules_engine.get_rule(camera_id)}\"")

    while True:
        try:
            jpeg_bytes = await asyncio.wait_for(queue.get(), timeout=BROWSER_FRAME_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            print(f"[{camera_id}] No browser frames received in {BROWSER_FRAME_TIMEOUT_SEC:.0f}s. Will retry.")
            return

        # The browser sends compressed JPEGs at a self-throttled rate, so we
        # publish every ingested frame directly to the live view.
        shared_state.update_frame(camera_id, jpeg_bytes)

        frame = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            continue

        processor.update_buffer(frame)
        await _process_frame(
            camera_id, frame, processor, gatekeeper, rules_engine, fusion_engine,
            vlm, vlm_semaphore, pending_tasks, state,
        )


def _new_event_state() -> dict:
    """Fresh state for one camera's event-recording state machine."""
    return {
        "is_recording": False,
        "post_trigger_count": 0,
        "event_payload": [],
        "event_detections": [],
        # Minimum gap between VLM dispatches on this camera.
        "last_dispatch_time": 0.0,
    }


async def _process_frame(
    camera_id: str,
    frame,
    processor: VideoProcessor,
    gatekeeper: Gatekeeper,
    rules_engine: RulesEngine,
    fusion_engine: FusionEngine,
    vlm: VLMClient,
    vlm_semaphore: asyncio.Semaphore,
    pending_tasks: list,
    state: dict,
):
    """
    Shared Tier 2/3 gating and event-recording state machine, used by both
    frame sources. `state` (see _new_event_state) is mutated in place.
    """
    # Active event recording.
    if state["is_recording"]:
        state["event_payload"].append(frame)
        state["post_trigger_count"] += 1

        if state["post_trigger_count"] >= config.BUFFER_SIZE_FRAMES:
            # Skip the VLM call if nothing changed meaningfully across the
            # captured event buffer.
            if not processor.event_has_major_change(state["event_payload"]):
                print(f"[{camera_id}] Event buffer complete but no major change detected. Skipping VLM call.")
            else:
                # Dispatch asynchronously so stream ingestion isn't blocked.
                # Tracked in pending_tasks so run_pipeline waits for it before exit.
                print(f"[{camera_id}] Context buffer complete. Dispatching to VLM.")
                state["last_dispatch_time"] = time.monotonic()
                task = asyncio.create_task(
                    dispatch_to_vlm(
                        camera_id, vlm, rules_engine, fusion_engine,
                        list(state["event_payload"]), list(state["event_detections"]),
                        vlm_semaphore,
                    )
                )
                pending_tasks.append(task)

            # Reset state machine to idle
            state["is_recording"] = False
            state["post_trigger_count"] = 0
            state["event_payload"] = []
            state["event_detections"] = []
        return

    # Tier 2: spatial pruning.
    if not processor.is_significant_change(frame):
        return

    # Tier 3: semantic gatekeeper and re-identification.
    gate_result = gatekeeper.detect(frame)
    if gate_result.triggered:
        # Skip starting a new event if a dispatch fired too recently.
        dispatch_cooldown = camera_setting(config, camera_id, "vlm_dispatch_cooldown_sec")
        if (time.monotonic() - state["last_dispatch_time"]) < dispatch_cooldown:
            return

        detected_classes = {d.class_name for d in gate_result.detections}
        # Hard pre-filter (object classes, time-of-day, day-of-week) applied
        # before the free-text rule, so impossible matches skip the VLM call.
        if not rules_engine.passes_constraints(camera_id, detected_classes, datetime.datetime.now()):
            return

        print(f"[{camera_id}][Gatekeeper] Target class detected. Starting event capture.")
        state["is_recording"] = True
        state["event_detections"] = [dataclasses.asdict(d) for d in gate_result.detections]

        # Seed the payload with the pre-trigger context.
        state["event_payload"] = processor.get_pre_trigger_context()


async def dispatch_to_vlm(
    camera_id: str,
    vlm: VLMClient,
    rules_engine: RulesEngine,
    fusion_engine: FusionEngine,
    frames: list,
    detections: list,
    vlm_semaphore: asyncio.Semaphore,
):
    """Handle async cloud analysis, rule filtering, fusion and output."""
    prompt = rules_engine.build_prompt(camera_id)
    # Bound how many VLM calls are in-flight at once across all cameras.
    async with vlm_semaphore:
        incident = await vlm.analyze_event(frames, detections=detections, prompt=prompt)
    incident["camera_id"] = camera_id

    # Some cameras (e.g. a monitored safe or entryway) should treat every
    # event as the same severity regardless of the VLM's own assessment.
    forced_severity = config.CAMERA_SEVERITY_OVERRIDE.get(camera_id)
    if forced_severity and not incident.get("error"):
        incident["severity"] = forced_severity
        incident["severity_forced"] = True

    print(f"[{camera_id}] Incident report:")
    print(json.dumps(incident, indent=2, default=str))

    # A missing API key or failed request produces a placeholder report rather
    # than a real assessment. Log it, but don't forward it to fusion/alerting.
    if incident.get("error"):
        print(f"[{camera_id}][VLM] Skipping alert dispatch - analysis call failed: {incident['error']}")
        return

    # The operator's plain-English rule was templated into the prompt; only
    # continue if the model judged the event a match.
    if not incident.get("matches_rule", True):
        print(f"[{camera_id}][Rules] Event did not match configured rule "
              f"({incident.get('rule_rationale', 'no rationale given')}). Suppressing alert.")
        return

    # Optionally persist a snapshot photo and/or short clip of the event
    # buffer to disk, and attach their URLs so the dashboard can display them
    # alongside the incident report.
    if config.SAVE_INCIDENT_MEDIA:
        try:
            incident.update(save_incident_media(camera_id, frames))
        except Exception as e:
            print(f"[{camera_id}][Media] Failed to save incident media: {e}")

    # Correlate with events from other cameras, then fan the report out to the
    # configured channels based on per-channel minimum severity.
    await fusion_engine.submit(camera_id, incident)


async def camera_manager(
    vlm: VLMClient,
    rules_engine: RulesEngine,
    fusion_engine: FusionEngine,
    pending_tasks: list,
    running_tasks: dict,
    vlm_semaphore: asyncio.Semaphore,
):
    """
    Reconcile the running camera pipelines against config.CAMERAS every couple
    of seconds, so cameras added/removed/edited in the dashboard take effect
    without a restart. Also auto-reconnects a camera whose stream ended.
    """
    last_started: dict[str, float] = {}

    while True:
        desired = {cam["id"]: cam["source"] for cam in config.CAMERAS}
        now = time.monotonic()

        for cam_id, source in desired.items():
            task = running_tasks.get(cam_id)
            needs_start = task is None or task.done()
            cooled_down = (now - last_started.get(cam_id, 0)) >= RECONNECT_DELAY_SEC
            if needs_start and cooled_down:
                verb = "Restarting" if task is not None else "Starting"
                print(f"[CameraManager] {verb} pipeline for camera '{cam_id}'.")
                if source == BROWSER_SOURCE:
                    running_tasks[cam_id] = asyncio.create_task(
                        run_browser_camera_pipeline(
                            cam_id, vlm, rules_engine, fusion_engine, pending_tasks, vlm_semaphore
                        )
                    )
                else:
                    running_tasks[cam_id] = asyncio.create_task(
                        run_camera_pipeline(
                            cam_id, source, vlm, rules_engine, fusion_engine, pending_tasks, vlm_semaphore
                        )
                    )
                last_started[cam_id] = now

        for cam_id in list(running_tasks.keys()):
            if cam_id not in desired:
                print(f"[CameraManager] Stopping pipeline for removed camera '{cam_id}'.")
                running_tasks[cam_id].cancel()
                running_tasks.pop(cam_id, None)
                last_started.pop(cam_id, None)

        await asyncio.sleep(2)


async def run_pipeline():
    print("Initializing video pipeline...")
    vlm = VLMClient()
    rules_engine = RulesEngine()
    alert_dispatcher = AlertDispatcher()
    fusion_engine = FusionEngine(alert_dispatcher)
    bind_rules_engine(rules_engine)
    bind_vlm_client(vlm)

    print(f"Starting camera pipeline(s): {[c['id'] for c in config.CAMERAS]}")

    # Background VLM-dispatch tasks appended by each pipeline, so we can wait
    # for them to finish rather than cancelling them mid-flight at EOF.
    pending_tasks: list = []
    running_tasks: dict = {}
    # Caps total in-flight VLM requests across all cameras.
    vlm_semaphore = asyncio.Semaphore(config.VLM_MAX_CONCURRENT_REQUESTS)

    manager_task = asyncio.create_task(
        camera_manager(vlm, rules_engine, fusion_engine, pending_tasks, running_tasks, vlm_semaphore)
    )

    try:
        await manager_task
    except asyncio.CancelledError:
        print("\nTerminating pipeline gracefully...")
    finally:
        for t in running_tasks.values():
            t.cancel()
        # Let in-flight VLM dispatches and downstream alerting finish.
        still_running = [t for t in pending_tasks if not t.done()]
        if still_running:
            print(f"Waiting for {len(still_running)} pending VLM dispatch(es) to complete...")
            await asyncio.gather(*still_running, return_exceptions=True)
        # Grace period for the fusion engine's flush-delay timer.
        await asyncio.sleep(config.FUSION_FLUSH_DELAY_SEC + 1)


if __name__ == "__main__":
    import uvicorn
    from api_server import app as api_app

    async def _main():
        server_config = uvicorn.Config(api_app, host=config.API_HOST, port=config.API_PORT, log_level="warning")
        server = uvicorn.Server(server_config)
        print(f"API listening on http://{config.API_HOST}:{config.API_PORT}")
        await asyncio.gather(run_pipeline(), server.serve())

    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        print("\nShutting down...")

