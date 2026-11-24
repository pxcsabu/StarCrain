/**
 * Pure Web Audio API notification tone synthesizer for time signals, timer completion, and alarms.
 * Requires zero external audio assets.
 */

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

function scheduleTone(
  ctx: AudioContext,
  freqHz: number,
  startOffsetSec: number,
  durationSec: number,
  gainPeak: number,
  type: OscillatorType = "sine",
): void {
  const start = ctx.currentTime + startOffsetSec;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqHz, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationSec + 0.02);
}

/** Play classic NHK-style time signal (440 Hz pips + 880 Hz on the hour, or soft double tone on half-hour). */
export function playTimeSignal(isHalfHour = false): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (isHalfHour) {
    scheduleTone(ctx, 660, 0, 0.14, 0.14, "sine");
    scheduleTone(ctx, 880, 0.18, 0.22, 0.14, "sine");
    return;
  }
  scheduleTone(ctx, 440, 0.0, 0.1, 0.14, "sine");
  scheduleTone(ctx, 440, 0.28, 0.1, 0.14, "sine");
  scheduleTone(ctx, 440, 0.56, 0.1, 0.14, "sine");
  scheduleTone(ctx, 880, 0.85, 0.65, 0.2, "sine");
}

/** Pleasant 3-note ascending chime for countdown timer completion. */
export function playTimerComplete(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((hz, idx) => {
    scheduleTone(ctx, hz, idx * 0.14, 0.45, 0.18, "triangle");
  });
}

/** Clear repeating alert chime for scheduled alarms. */
export function playAlarmRing(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  for (let rep = 0; rep < 3; rep++) {
    const base = rep * 0.55;
    scheduleTone(ctx, 880, base, 0.12, 0.2, "triangle");
    scheduleTone(ctx, 1174.66, base + 0.14, 0.18, 0.2, "triangle");
  }
}

/** Short feedback tone when testing sound output. */
export function playTestBeep(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  scheduleTone(ctx, 660, 0, 0.14, 0.15, "sine");
  scheduleTone(ctx, 990, 0.15, 0.24, 0.15, "sine");
}
