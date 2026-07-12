import cv2
import json
import base64
import numpy as np
from groq import AsyncGroq
from config import config
from rules import JSON_INSTRUCTIONS

# Fallback prompt used when no camera-specific rule/prompt is supplied (e.g.
# direct/legacy calls to analyze_event without a RulesEngine). See rules.py
# for the dynamic, per-camera, natural-language rule templating.
_DEFAULT_PROMPT = (
    "You are a security analyst reviewing a triggered camera event. "
    "Describe what is happening, identify each notable person/vehicle, and assess "
    "how serious this event is (e.g. a delivery is low/medium, a break-in attempt is "
    "high/critical). " + JSON_INSTRUCTIONS
)


class VLMClient:
    def __init__(self):
        # Async client so VLM calls don't block the video loop.
        self.client = AsyncGroq(api_key=config.GROQ_API_KEY)

    def update_api_key(self, api_key: str):
        """Recreate the Groq client with a new key without a restart."""
        config.GROQ_API_KEY = api_key
        self.client = AsyncGroq(api_key=api_key)

    def _sample_frames(self, frames: list[np.ndarray], max_frames: int = 5) -> list[np.ndarray]:
        """
        Groq vision models allow at most 5 images per request. Evenly space
        the sampled frames to cover the full event timeline.
        """
        if len(frames) <= max_frames:
            return frames
        indices = np.linspace(0, len(frames) - 1, max_frames, dtype=int)
        return [frames[i] for i in indices]

    def _encode_for_vlm(self, frames: list[np.ndarray]) -> list[dict]:
        """Convert OpenCV BGR arrays to Base64 data URIs for the Groq API."""
        image_payloads = []
        for f in frames:
            # JPEG-compress to reduce payload size and latency.
            _, buffer = cv2.imencode('.jpg', f, [cv2.IMWRITE_JPEG_QUALITY, 80])
            b64_str = base64.b64encode(buffer).decode('utf-8')
            image_payloads.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{b64_str}"
                }
            })
        return image_payloads

    @staticmethod
    def _parse_structured_response(raw_text: str) -> dict:
        """Best-effort JSON parsing with a safe fallback if the model adds stray text."""
        text = raw_text.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            start, end = text.find("{"), text.rfind("}")
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(text[start:end + 1])
                except json.JSONDecodeError:
                    pass
            return {
                "summary": raw_text,
                "severity": "unknown",
                "entities": [],
                "parse_error": True,
            }

    async def analyze_event(
        self,
        frames: list[np.ndarray],
        detections: list[dict] | None = None,
        prompt: str | None = None,
    ) -> dict:
        """
        Analyze an event and return a structured incident report (severity,
        entities, summary, rule-match verdict), with the local YOLO detections
        merged in under "detections".

        `prompt` is normally built per-camera by RulesEngine.build_prompt();
        falls back to a generic prompt if omitted.
        """
        if not config.GROQ_API_KEY:
            return {
                "summary": "Missing Groq API Key. Analysis skipped.",
                "severity": "unknown",
                "matches_rule": True,
                "entities": [],
                "detections": detections or [],
                "error": "missing_api_key",
            }

        # Downsample to respect API limits while preserving temporal context.
        optimized_frames = self._sample_frames(frames, max_frames=5)
        print(f"[VLM] Uploading {len(optimized_frames)} frames to Groq.")

        content = [{"type": "text", "text": prompt or _DEFAULT_PROMPT}]
        content.extend(self._encode_for_vlm(optimized_frames))

        try:
            response = await self.client.chat.completions.create(
                model=config.VLM_MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": content
                    }
                ],
                max_tokens=500,
                response_format={"type": "json_object"},
            )
            report = self._parse_structured_response(response.choices[0].message.content)
        except Exception as e:
            report = {
                "summary": f"Failed to analyze event with Groq. {str(e)}",
                "severity": "unknown",
                "matches_rule": True,
                "entities": [],
                "error": str(e),
            }

        report.setdefault("matches_rule", True)
        report["detections"] = detections or []
        return report
