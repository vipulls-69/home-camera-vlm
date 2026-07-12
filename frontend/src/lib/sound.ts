/**
 * Severity-based in-app alert feedback: audible tone (Web Audio API, no
 * binary assets required) + haptic vibration pattern (navigator.vibrate,
 * no-ops gracefully on unsupported browsers/desktops).
 */
import type { Severity } from "@/lib/api";

interface SeverityProfile {
  frequencies: number[]; // Hz, played in sequence
  beepDurationMs: number;
  gapMs: number;
  vibratePattern: number[]; // ms on/off pairs
  volume: number; // 0-1
}

const PROFILES: Record<Severity, SeverityProfile> = {
  low: { frequencies: [440], beepDurationMs: 120, gapMs: 80, vibratePattern: [80], volume: 0.15 },
  medium: { frequencies: [523, 659], beepDurationMs: 140, gapMs: 90, vibratePattern: [100, 60, 100], volume: 0.22 },
  high: { frequencies: [659, 784, 659], beepDurationMs: 150, gapMs: 80, vibratePattern: [150, 60, 150, 60, 150], volume: 0.3 },
  critical: {
    frequencies: [880, 660, 880, 660],
    beepDurationMs: 160,
    gapMs: 60,
    vibratePattern: [200, 80, 200, 80, 200, 80, 200],
    volume: 0.4,
  },
  unknown: { frequencies: [330], beepDurationMs: 100, gapMs: 60, vibratePattern: [60], volume: 0.12 },
};

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/** Must be called from a user gesture at least once to unlock audio in some browsers. */
export function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
}

function playTone(ctx: AudioContext, freq: number, durationMs: number, volume: number, startTime: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = freq;
  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationMs / 1000);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + durationMs / 1000);
}

/** Plays a short severity-coded chime and triggers a matching vibration pattern. */
export function playSeverityAlert(severity: Severity) {
  const profile = PROFILES[severity] ?? PROFILES.unknown;

  const ctx = getAudioContext();
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    let t = ctx.currentTime;
    for (const freq of profile.frequencies) {
      playTone(ctx, freq, profile.beepDurationMs, profile.volume, t);
      t += (profile.beepDurationMs + profile.gapMs) / 1000;
    }
  }

  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(profile.vibratePattern);
    } catch {
      // unsupported - ignore
    }
  }
}
