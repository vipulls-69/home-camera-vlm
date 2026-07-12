"""
Alert routing.

Takes a structured incident report and fans it out to the configured
notification channels (Slack, generic webhook, Twilio SMS, PagerDuty) based on
each channel's minimum severity in config.py. Channels are plain HTTP POSTs
dispatched concurrently via asyncio.to_thread so the video loop is never
blocked by a slow endpoint.
"""
import asyncio
import time
import requests
from config import config
from shared_state import shared_state

_SEVERITY_RANK = {level: i for i, level in enumerate(config.SEVERITY_LEVELS)}


def _meets_threshold(severity: str, channel: str) -> bool:
    min_severity = config.ALERT_MIN_SEVERITY.get(channel, "low")
    return _SEVERITY_RANK.get(severity, 0) >= _SEVERITY_RANK.get(min_severity, 0)


class AlertDispatcher:
    def __init__(self, timeout_sec: float = 5.0):
        self.timeout_sec = timeout_sec

    async def dispatch(self, incident: dict) -> dict:
        """Route an incident report to every eligible channel concurrently."""
        severity = incident.get("severity", "unknown")
        tasks = {}
        results = {}

        for channel in config.ALERT_CHANNELS:
            if not _meets_threshold(severity, channel):
                continue
            if channel == "in_app":
                # Run inline: asyncio.Queue is not thread-safe to touch from
                # outside the event loop.
                shared_state.add_incident(incident)
                results["in_app"] = {"ok": True}
                continue
            handler = getattr(self, f"_send_{channel}", None)
            if handler is None:
                continue
            tasks[channel] = asyncio.create_task(asyncio.to_thread(handler, incident))

        for channel, task in tasks.items():
            try:
                results[channel] = await task
            except Exception as e:
                results[channel] = {"ok": False, "error": str(e)}
        return results

    # --- Channel senders (run in a worker thread) ---

    def _send_slack(self, incident: dict) -> dict:
        if not config.SLACK_WEBHOOK_URL:
            return {"ok": False, "error": "SLACK_WEBHOOK_URL not configured"}

        entities_text = ", ".join(
            f"{e.get('label', '?')} ({e.get('description', 'n/a')})" for e in incident.get("entities", [])
        ) or "none"

        text = (
            f"*Security Alert - {incident.get('severity', 'unknown').upper()}*\n"
            f"{incident.get('summary', '')}\n"
            f"Entities: {entities_text}"
        )
        resp = requests.post(config.SLACK_WEBHOOK_URL, json={"text": text}, timeout=self.timeout_sec)
        return {"ok": resp.ok, "status_code": resp.status_code}

    def _send_webhook(self, incident: dict) -> dict:
        if not config.GENERIC_WEBHOOK_URL:
            return {"ok": False, "error": "GENERIC_WEBHOOK_URL not configured"}

        resp = requests.post(config.GENERIC_WEBHOOK_URL, json=incident, timeout=self.timeout_sec)
        return {"ok": resp.ok, "status_code": resp.status_code}

    def _send_sms(self, incident: dict) -> dict:
        if not (config.TWILIO_ACCOUNT_SID and config.TWILIO_AUTH_TOKEN and config.ALERT_SMS_TO):
            return {"ok": False, "error": "Twilio SMS not configured"}

        url = f"https://api.twilio.com/2010-04-01/Accounts/{config.TWILIO_ACCOUNT_SID}/Messages.json"
        body = f"[{incident.get('severity', 'unknown').upper()}] {incident.get('summary', '')[:280]}"
        resp = requests.post(
            url,
            data={"From": config.TWILIO_FROM_NUMBER, "To": config.ALERT_SMS_TO, "Body": body},
            auth=(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN),
            timeout=self.timeout_sec,
        )
        return {"ok": resp.ok, "status_code": resp.status_code}

    def _send_pagerduty(self, incident: dict) -> dict:
        if not config.PAGERDUTY_ROUTING_KEY:
            return {"ok": False, "error": "PAGERDUTY_ROUTING_KEY not configured"}

        payload = {
            "routing_key": config.PAGERDUTY_ROUTING_KEY,
            "event_action": "trigger",
            "payload": {
                "summary": incident.get("summary", "Security event detected")[:1024],
                "severity": incident.get("severity", "critical") if incident.get("severity") in
                ("critical", "warning", "error", "info") else "critical",
                "source": "ai-video-pipeline",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "custom_details": incident,
            },
        }
        resp = requests.post(
            "https://events.pagerduty.com/v2/enqueue", json=payload, timeout=self.timeout_sec
        )
        return {"ok": resp.ok, "status_code": resp.status_code}
