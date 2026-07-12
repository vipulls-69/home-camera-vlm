"""
Rules engine.

Each camera can be configured with a plain-English rule describing what counts
as an alertable incident. The rule text is templated into the VLM prompt and
the model is asked to judge whether the event satisfies it (returned as
"matches_rule" / "rule_rationale"). A separate structured constraint layer
(classes / time-of-day / day-of-week) acts as a hard pre-filter before the
VLM call.
"""
import datetime
from config import config

DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# JSON schema instructions shared with the VLM client.
JSON_INSTRUCTIONS = (
    "Respond with ONLY a single JSON object (no markdown, no prose) matching this schema:\n"
    "{\n"
    '  "summary": string,                 // one paragraph describing the event\n'
    '  "severity": "low"|"medium"|"high"|"critical",\n'
    '  "matches_rule": boolean,           // true only if the event satisfies the operator rule above\n'
    '  "rule_rationale": string,          // brief explanation of why it does/doesn\'t match the rule\n'
    '  "entities": [\n'
    "    {\n"
    '      "label": string,               // e.g. "person", "car", "motorcycle"\n'
    '      "description": string,         // notable attributes (clothing, color, behavior)\n'
    '      "confidence": number           // 0.0-1.0 estimate of how certain you are\n'
    "    }\n"
    "  ]\n"
    "}"
)


class RulesEngine:
    def __init__(self):
        self._rules: dict[str, str] = dict(config.CAMERA_RULES)
        self._constraints: dict[str, list[dict]] = {
            cam_id: list(constraints) for cam_id, constraints in config.CAMERA_RULE_CONSTRAINTS.items()
        }

    def get_rule(self, camera_id: str) -> str:
        return self._rules.get(camera_id, config.DEFAULT_RULE)

    def set_rule(self, camera_id: str, rule_text: str):
        """Update a camera's rule at runtime."""
        self._rules[camera_id] = rule_text

    # --- Structured constraints (hard pre-filter) ---

    def get_constraints(self, camera_id: str) -> list[dict]:
        return self._constraints.get(camera_id, [])

    def set_constraints(self, camera_id: str, constraints: list[dict]):
        """Update a camera's structured constraints at runtime."""
        self._constraints[camera_id] = constraints

    @staticmethod
    def _time_in_window(now_time: datetime.time, start: str | None, end: str | None) -> bool:
        if not start and not end:
            return True
        start_t = datetime.datetime.strptime(start, "%H:%M").time() if start else datetime.time.min
        end_t = datetime.datetime.strptime(end, "%H:%M").time() if end else datetime.time.max
        if start_t <= end_t:
            return start_t <= now_time <= end_t
        # Overnight window (e.g. 22:00 -> 06:00)
        return now_time >= start_t or now_time <= end_t

    def passes_constraints(
        self, camera_id: str, detected_classes: set[str], now: datetime.datetime | None = None
    ) -> bool:
        """
        Hard gate evaluated before the VLM call. An empty constraint list means
        no hard constraint (always pass). Otherwise the event must satisfy at
        least one constraint; a constraint's own classes/days/time fields are
        AND'd together.
        """
        constraints = self.get_constraints(camera_id)
        if not constraints:
            return True

        now = now or datetime.datetime.now()
        today_code = DAY_CODES[now.weekday()]

        for c in constraints:
            classes = set(c.get("classes") or [])
            if classes and not (classes & detected_classes):
                continue
            days = set(c.get("days") or [])
            if days and today_code not in days:
                continue
            if not self._time_in_window(now.time(), c.get("start_time"), c.get("end_time")):
                continue
            return True
        return False

    @staticmethod
    def _describe_constraints(constraints: list[dict]) -> str:
        lines = []
        for c in constraints:
            parts = []
            if c.get("classes"):
                parts.append("objects: " + ", ".join(c["classes"]))
            if c.get("days"):
                parts.append("days: " + ", ".join(c["days"]))
            if c.get("start_time") or c.get("end_time"):
                parts.append(f"time window: {c.get('start_time') or '00:00'}-{c.get('end_time') or '23:59'}")
            if c.get("note"):
                parts.append(c["note"])
            if parts:
                lines.append("  - " + "; ".join(parts))
        return "\n".join(lines)

    def build_prompt(self, camera_id: str) -> str:
        """Template the camera's rule and current time context into a prompt."""
        rule_text = self.get_rule(camera_id)
        now = datetime.datetime.now()
        constraints = self.get_constraints(camera_id)
        constraints_block = ""
        if constraints:
            constraints_block = (
                "\n\nThis event already passed the operator's structured constraints "
                "(pre-filtered by the system before reaching you):\n" + self._describe_constraints(constraints)
            )

        return (
            f"You are a security analyst reviewing a triggered camera event from camera "
            f"'{camera_id}' at local time {now.strftime('%Y-%m-%d %H:%M:%S')} "
            f"({now.strftime('%A')}).\n\n"
            f"The operator has defined the following alerting rule in plain English:\n"
            f"\"{rule_text}\"{constraints_block}\n\n"
            "Carefully evaluate whether the observed event satisfies this rule - do not "
            "assume every detection is alertable. Describe what is happening, identify each "
            "notable person/vehicle, and assess how serious this event is. " + JSON_INSTRUCTIONS
        )

