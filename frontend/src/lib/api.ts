/**
 * Typed REST/WebSocket client for the FastAPI backend (api_server.py).
 * Base URL is configurable via NEXT_PUBLIC_API_BASE_URL (defaults to
 * localhost:8000, matching config.API_HOST/API_PORT).
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:8000";

export const WS_BASE = API_BASE.replace(/^http/, "ws");

/** Sentinel Camera.source value meaning "fed by this browser's own webcam
 * via getUserMedia" (see WebcamUploader), rather than a URL/path the backend
 * opens itself with cv2.VideoCapture. Must match main.py's BROWSER_SOURCE. */
export const BROWSER_CAMERA_SOURCE = "browser";

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export interface Camera {
  id: string;
  source: string;
}

export interface Entity {
  label: string;
  description: string;
  confidence: number;
}

export interface Detection {
  track_id: number | null;
  cls_id: number;
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface TimelineEntry {
  camera_id: string;
  offset_sec: number;
  summary: string;
  severity: Severity;
  entities: Entity[];
  photo_url?: string | null;
  video_url?: string | null;
}

export interface Incident {
  summary: string;
  severity: Severity;
  matches_rule?: boolean;
  rule_rationale?: string;
  entities: Entity[];
  detections: Detection[];
  camera_id?: string;
  cameras?: string[];
  timeline?: TimelineEntry[];
  fused?: boolean;
  error?: string;
  received_at?: number;
  /** Present when config.SAVE_INCIDENT_MEDIA is enabled - relative paths
   * served by the backend at /media/..., resolve with mediaUrl(). */
  photo_url?: string | null;
  video_url?: string | null;
}

export interface MediaConfig {
  save_media: boolean;
  save_photos: boolean;
  save_videos: boolean;
}

export interface AlertConfig {
  channels: string[];
  min_severity: Record<string, Severity>;
  severity_levels: Severity[];
  slack_webhook_url: string;
  generic_webhook_url: string;
  sms_to: string;
  twilio_account_sid: string;
  twilio_from_number: string;
  has_twilio_auth_token: boolean;
  twilio_auth_token_preview: string;
  has_pagerduty_key: boolean;
  pagerduty_key_preview: string;
}

export interface LLMConfig {
  has_key: boolean;
  key_preview: string;
  model: string;
}

export interface RuleConstraint {
  classes: string[];
  days: string[];
  start_time: string | null;
  end_time: string | null;
  note: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listCameras: () => request<{ cameras: Camera[] }>("/api/cameras"),
  upsertCamera: (cam: Camera) =>
    request<{ ok: boolean; cameras: Camera[] }>("/api/cameras", {
      method: "POST",
      body: JSON.stringify(cam),
    }),
  deleteCamera: (id: string) =>
    request<{ ok: boolean; cameras: Camera[] }>(`/api/cameras/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** Uploads one JPEG frame captured client-side (e.g. via getUserMedia) for
   * a camera whose source is the "browser" sentinel. See WebcamUploader. */
  ingestFrame: (cameraId: string, blob: Blob) =>
    fetch(`${API_BASE}/api/ingest/${encodeURIComponent(cameraId)}`, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": "image/jpeg" },
    }),

  listRules: () =>
    request<{ default_rule: string; camera_rules: Record<string, string> }>("/api/rules"),
  updateDefaultRule: (rule: string) =>
    request<{ ok: boolean }>("/api/rules/default", {
      method: "PUT",
      body: JSON.stringify({ rule }),
    }),
  updateRule: (cameraId: string, rule: string) =>
    request<{ ok: boolean }>(`/api/rules/${encodeURIComponent(cameraId)}`, {
      method: "PUT",
      body: JSON.stringify({ rule }),
    }),

  getAlertConfig: () => request<AlertConfig>("/api/alerts/config"),
  updateAlertConfig: (body: Partial<AlertConfig> & Record<string, unknown>) =>
    request<{ ok: boolean }>("/api/alerts/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  getLLMConfig: () => request<LLMConfig>("/api/llm/config"),
  updateLLMConfig: (body: { api_key?: string; model?: string }) =>
    request<LLMConfig & { ok: boolean }>("/api/llm/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  getDetectionClasses: () => request<{ classes: string[] }>("/api/detection-classes"),

  getConstraints: (cameraId: string) =>
    request<{ constraints: RuleConstraint[] }>(`/api/rules/${encodeURIComponent(cameraId)}/constraints`),
  updateConstraints: (cameraId: string, constraints: RuleConstraint[]) =>
    request<{ ok: boolean; constraints: RuleConstraint[] }>(
      `/api/rules/${encodeURIComponent(cameraId)}/constraints`,
      { method: "PUT", body: JSON.stringify({ constraints }) }
    ),

  getIncidents: (limit = 50) => request<{ incidents: Incident[] }>(`/api/incidents?limit=${limit}`),

  getMediaConfig: () => request<MediaConfig>("/api/media/config"),
  updateMediaConfig: (body: Partial<MediaConfig>) =>
    request<MediaConfig & { ok: boolean }>("/api/media/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  streamUrl: (cameraId: string) => `${API_BASE}/api/stream/${encodeURIComponent(cameraId)}`,
  snapshotUrl: (cameraId: string) =>
    `${API_BASE}/api/stream/${encodeURIComponent(cameraId)}/snapshot`,
};

/** Resolves a relative incident media path (e.g. "/media/front_door/xyz.jpg")
 * returned by the backend into an absolute, fetchable URL. */
export function mediaUrl(path: string): string {
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

/** Opens the real-time incident WebSocket used to drive in-app alerts. */
export function connectIncidentSocket(onIncident: (incident: Incident) => void): () => void {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    socket = new WebSocket(`${WS_BASE}/ws/incidents`);
    socket.onmessage = (event) => {
      try {
        onIncident(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };
    socket.onclose = () => {
      if (!closedByUser) {
        retryTimer = setTimeout(connect, 3000);
      }
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    closedByUser = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
