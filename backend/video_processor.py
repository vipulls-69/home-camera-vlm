import cv2
import time
import numpy as np
from collections import deque
from config import config

class VideoProcessor:
    def __init__(self):
        # Ring buffer of pre-trigger context frames.
        self.frame_buffer = deque(maxlen=config.BUFFER_SIZE_FRAMES)
        self.prev_frame_gray = None

        # Rolling window of recent quiet-scene change percentages, used to
        # estimate the noise floor so the motion threshold self-tunes per camera.
        self._motion_samples = deque(maxlen=config.MOTION_BASELINE_WINDOW)
        self.effective_motion_threshold = config.MOTION_THRESHOLD

        # Last time motion was observed, so the loop can sample faster during
        # active periods and relax back to TARGET_FPS when quiet.
        self._last_motion_time = 0.0

    def _update_effective_threshold(self, change_percentage: float, triggered: bool):
        """Recompute the adaptive motion threshold from the recent noise floor."""
        if not config.ADAPTIVE_MOTION_ENABLED:
            self.effective_motion_threshold = config.MOTION_THRESHOLD
            return

        # Only feed quiet samples into the baseline so a real event doesn't
        # drag the threshold upward.
        if not triggered:
            self._motion_samples.append(change_percentage)

        if len(self._motion_samples) < max(5, config.MOTION_BASELINE_WINDOW // 4):
            self.effective_motion_threshold = config.MOTION_THRESHOLD
            return

        mean = float(np.mean(self._motion_samples))
        std = float(np.std(self._motion_samples))
        adaptive = mean + config.MOTION_ADAPTIVE_STDDEV_MULTIPLIER * std

        self.effective_motion_threshold = min(
            config.MOTION_THRESHOLD_MAX,
            max(config.MOTION_THRESHOLD_MIN, adaptive),
        )

    def is_significant_change(self, frame: np.ndarray) -> bool:
        """
        Tier 2: detect structural change via absolute difference. The threshold
        self-tunes to each camera's noise floor.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)

        if self.prev_frame_gray is None:
            self.prev_frame_gray = gray
            return True  # Process the first frame to establish a baseline.

        frame_delta = cv2.absdiff(self.prev_frame_gray, gray)
        thresh = cv2.threshold(frame_delta, 25, 255, cv2.THRESH_BINARY)[1]

        non_zero_count = np.count_nonzero(thresh)
        change_percentage = (non_zero_count / thresh.size) * 100

        self.prev_frame_gray = gray

        triggered = change_percentage >= self.effective_motion_threshold
        self._update_effective_threshold(change_percentage, triggered)

        if triggered:
            self._last_motion_time = time.monotonic()

        return triggered

    def get_target_fps(self) -> float:
        """
        Return a higher sampling rate while the scene is active, relaxing back
        to TARGET_FPS once quiet for ADAPTIVE_FPS_COOLDOWN_SEC seconds.
        """
        if not config.ADAPTIVE_FPS_ENABLED:
            return config.TARGET_FPS

        if (time.monotonic() - self._last_motion_time) <= config.ADAPTIVE_FPS_COOLDOWN_SEC:
            return max(config.TARGET_FPS, config.MAX_TARGET_FPS)

        return config.TARGET_FPS

    def update_buffer(self, frame: np.ndarray):
        """Maintains the rolling window of frames for pre-trigger context."""
        self.frame_buffer.append(frame)

    def get_pre_trigger_context(self) -> list[np.ndarray]:
        """Returns the current state of the ring buffer."""
        return list(self.frame_buffer)

    def event_has_major_change(self, frames: list[np.ndarray]) -> bool:
        """
        Diff gate on the full captured event buffer, evaluated before a VLM
        call. Compares evenly-spaced frames across the event window and only
        passes if the max structural change clears EVENT_DIFF_THRESHOLD, so
        events where the scene never meaningfully changes are skipped.
        """
        if not config.EVENT_DIFF_ENABLED:
            return True
        if len(frames) < 2:
            return True

        # Sample a handful of evenly-spaced frames instead of every pair, so
        # this stays cheap even for a large event buffer.
        max_samples = 6
        step = max(1, len(frames) // max_samples)
        sampled = frames[::step]

        grays = [
            cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (21, 21), 0)
            for f in sampled
        ]

        max_change_percentage = 0.0
        for i in range(1, len(grays)):
            frame_delta = cv2.absdiff(grays[i - 1], grays[i])
            thresh = cv2.threshold(frame_delta, 25, 255, cv2.THRESH_BINARY)[1]
            change_percentage = (np.count_nonzero(thresh) / thresh.size) * 100
            max_change_percentage = max(max_change_percentage, change_percentage)

        return max_change_percentage >= config.EVENT_DIFF_THRESHOLD
