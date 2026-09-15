/**
 * Procedural sound engine.
 *
 * Every sound in the game is synthesised at runtime from scratch with the Web
 * Audio API: filtered white-noise bursts, pitch/amplitude envelopes, FM and AM
 * tones and short decaying oscillators. There are no sample files, no embedded
 * data URIs and no third-party audio anywhere in this module.
 *
 * Design notes
 * ------------
 * - One `AudioContext` is built lazily on the first `play()` and unlocked by
 *   `resume()` from a user gesture (browser autoplay policy).
 * - A couple of seconds of white noise are rendered once into an `AudioBuffer`
 *   and shared by every noise voice, so a sound never allocates a buffer.
 * - Voices are tracked in a small fixed-size pool; the oldest is faded out and
 *   stopped when the polyphony cap is reached, so nothing leaks or piles up.
 * - The whole module degrades to a no-op when Web Audio is unavailable (Node,
 *   SSR, headless smoke tests): `ready` stays false and nothing ever throws.
 */

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type SoundName =
  | 'step.stone' | 'step.dirt' | 'step.grass' | 'step.sand' | 'step.gravel' | 'step.wood' | 'step.cloth'
  | 'dig.stone' | 'dig.dirt' | 'dig.grass' | 'dig.sand' | 'dig.gravel' | 'dig.wood' | 'dig.glass' | 'dig.cloth'
  | 'break.stone' | 'break.dirt' | 'break.grass' | 'break.sand' | 'break.gravel' | 'break.wood' | 'break.glass' | 'break.cloth'
  | 'place.stone' | 'place.wood' | 'place.dirt' | 'place.sand'
  | 'pop'
  | 'hurt'
  | 'mob.hurt' | 'mob.death' | 'mob.idle'
  | 'splash' | 'swim' | 'fizz'
  | 'explosion'
  | 'bow'
  | 'click' | 'button'
  | 'levelup' | 'craft';

/** Block sound class accepted by `playBlock` (see `SoundClass` in world/blocks.ts). */
export type BlockSoundClass =
  | 'stone' | 'dirt' | 'grass' | 'sand' | 'gravel' | 'glass' | 'cloth' | 'wood' | 'plant' | 'liquid';

export interface PlayOptions {
  /** linear gain multiplier, 0..1+ (default 1) */
  volume?: number;
  /** playback rate multiplier (default 1) */
  pitch?: number;
  /** stereo position, -1 (left) .. 1 (right) */
  pan?: number;
}

export interface VolumeState {
  master: number;
  sfx: number;
  music: number;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Hard polyphony cap: the oldest fading voice is stolen beyond this. */
const MAX_VOICES = 24;
/** Length of the shared white-noise buffer, in seconds. */
const NOISE_SECONDS = 2;
/** Ignore an absurd dt (tab was backgrounded) instead of scheduling a burst. */
const MAX_DT = 0.25;
/** Music scheduler: pad cadence and the softest bell spacing. */
const PAD_INTERVAL = 13.5;
const BELL_INTERVAL = 7.5;
const BELL_CHANCE = 0.55;

/** A minor-pentatonic-flavoured bed: A2 root, original and deliberately sparse. */
const SCALE: readonly number[] = [
  110.0, 130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0,
];

/* ------------------------------------------------------------------ */
/* Browser guards                                                      */
/* ------------------------------------------------------------------ */

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function findAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  if (typeof g.AudioContext === 'function') return g.AudioContext;
  if (typeof g.webkitAudioContext === 'function') return g.webkitAudioContext;
  return null;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

const rnd = Math.random;

/** Exponential ramps cannot touch zero; this is our practical floor. */
const FLOOR = 1e-4;

/* ------------------------------------------------------------------ */
/* Internal records                                                    */
/* ------------------------------------------------------------------ */

interface Voice {
  nodes: AudioNode[];
  gain: GainNode;
  stopAt: number;
  /** context time of the last scheduled sample, for readable diagnostics */
  startedAt: number;
}

/**
 * A recipe is either a single gain+filter envelope driven by one source, or a
 * list of sources layered on a shared filter chain. Recipes are pure data so
 * that adding a sound is a data edit, not a new code path.
 */
type SourceKind = 'noise' | 'sine' | 'triangle' | 'square' | 'sawtooth';

interface SourceSpec {
  kind: SourceKind;
  /** frequency at the start of the envelope */
  freq: number;
  /** frequency at the end (defaults to `freq`) */
  freqEnd?: number;
  /** exponential/linear bend mode for the frequency envelope */
  bend?: 'exp' | 'lin';
  /** seconds between start and the frequency envelope's end */
  bendTime?: number;
  /** peak gain of this source */
  peak: number;
  /** attack time in seconds */
  attack?: number;
  /** decay/release time after the attack */
  hold?: number;
  /** 0 = percussive exponential decay, 1 = plucked linear-ish shaped decay */
  shape?: number;
  /** frequency modulation depth (percent of carrier) */
  fm?: number;
  /** FM modulator ratio relative to the carrier */
  fmRatio?: number;
  fmDecay?: number;
  /** amplitude modulation depth 0..1 */
  am?: number;
  amRate?: number;
  /** start offset in seconds (lets a recipe stagger layers) */
  delay?: number;
}

interface Recipe {
  dur: number;
  filter?: {
    type: BiquadFilterType;
    freq: number;
    freqEnd?: number;
    q?: number;
    /** filter sweep duration; defaults to the whole voice */
    sweep?: number;
  };
  sources: SourceSpec[];
  /** random playback-rate jitter applied per play, e.g. 0.12 = +/-12% */
  jitter?: number;
}

/* ------------------------------------------------------------------ */
/* Recipes                                                             */
/* ------------------------------------------------------------------ */

const RECIPES: Record<SoundName, Recipe> = {
  /* ---------------- footsteps: short, soft, material specific --------- */
  'step.stone': {
    dur: 0.11,
    filter: { type: 'bandpass', freq: 1000, freqEnd: 620, q: 0.9, sweep: 0.11 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.3, attack: 0.003, shape: 0.55, hold: 0.1 },
      { kind: 'triangle', freq: 168, freqEnd: 108, peak: 0.1, attack: 0.002, shape: 1, hold: 0.08 },
    ],
    jitter: 0.14,
  },
  'step.dirt': {
    dur: 0.1,
    filter: { type: 'lowpass', freq: 1150, freqEnd: 600, q: 0.5, sweep: 0.1 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.28, attack: 0.004, shape: 0.6, hold: 0.09 },
      { kind: 'sine', freq: 122, freqEnd: 84, peak: 0.12, attack: 0.002, shape: 1, hold: 0.08 },
    ],
    jitter: 0.16,
  },
  'step.grass': {
    dur: 0.075,
    filter: { type: 'highpass', freq: 2400, freqEnd: 3200, q: 0.6, sweep: 0.075 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.17, attack: 0.004, shape: 0.7, hold: 0.07 }],
    jitter: 0.18,
  },
  'step.sand': {
    dur: 0.095,
    filter: { type: 'highpass', freq: 1800, q: 0.5 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.14, attack: 0.016, shape: 0.8, hold: 0.08 }],
    jitter: 0.2,
  },
  'step.gravel': {
    dur: 0.12,
    filter: { type: 'bandpass', freq: 1450, freqEnd: 800, q: 0.8, sweep: 0.12 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.28, attack: 0.002, shape: 0.6, hold: 0.11 },
      { kind: 'noise', freq: 1, peak: 0.16, attack: 0.001, shape: 0.7, hold: 0.05, delay: 0.035 },
    ],
    jitter: 0.18,
  },
  'step.wood': {
    dur: 0.1,
    filter: { type: 'bandpass', freq: 820, freqEnd: 460, q: 1.1, sweep: 0.1 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.22, attack: 0.003, shape: 0.6, hold: 0.09 },
      { kind: 'triangle', freq: 196, freqEnd: 138, peak: 0.18, attack: 0.002, hold: 0.09 },
    ],
    jitter: 0.12,
  },
  'step.cloth': {
    dur: 0.085,
    filter: { type: 'lowpass', freq: 820, freqEnd: 460, q: 0.4, sweep: 0.085 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.16, attack: 0.012, shape: 0.75, hold: 0.07 }],
    jitter: 0.16,
  },

  /* ---------------- digging: the sound played while a block is mined -- */
  'dig.stone': {
    dur: 0.12,
    filter: { type: 'bandpass', freq: 1200, freqEnd: 780, q: 1.6, sweep: 0.12 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.42, attack: 0.002, shape: 0.5, hold: 0.09 },
      { kind: 'triangle', freq: 152, freqEnd: 106, peak: 0.12, attack: 0.002, shape: 1, hold: 0.07 },
    ],
    jitter: 0.16,
  },
  'dig.dirt': {
    dur: 0.11,
    filter: { type: 'lowpass', freq: 1050, freqEnd: 470, q: 0.7, sweep: 0.11 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.36, attack: 0.006, shape: 0.6, hold: 0.1 },
      { kind: 'sine', freq: 128, freqEnd: 82, peak: 0.16, attack: 0.002, shape: 1, hold: 0.08 },
    ],
    jitter: 0.18,
  },
  'dig.grass': {
    dur: 0.09,
    filter: { type: 'highpass', freq: 2100, q: 0.6 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.22, attack: 0.005, shape: 0.7, hold: 0.08 }],
    jitter: 0.2,
  },
  'dig.sand': {
    dur: 0.14,
    filter: { type: 'highpass', freq: 1700, freqEnd: 2600, q: 0.5, sweep: 0.14 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.22, attack: 0.03, shape: 0.85, hold: 0.11 }],
    jitter: 0.22,
  },
  'dig.gravel': {
    dur: 0.15,
    filter: { type: 'bandpass', freq: 1650, freqEnd: 850, q: 1.2, sweep: 0.15 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.4, attack: 0.002, shape: 0.55, hold: 0.13 },
      { kind: 'noise', freq: 1, peak: 0.22, attack: 0.001, shape: 0.6, hold: 0.06, delay: 0.03 },
      { kind: 'noise', freq: 1, peak: 0.18, attack: 0.001, shape: 0.6, hold: 0.05, delay: 0.065 },
    ],
    jitter: 0.2,
  },
  'dig.wood': {
    dur: 0.13,
    filter: { type: 'bandpass', freq: 1050, freqEnd: 520, q: 1.4, sweep: 0.13 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.3, attack: 0.002, shape: 0.55, hold: 0.09 },
      { kind: 'triangle', freq: 232, freqEnd: 148, peak: 0.24, attack: 0.002, shape: 0.9, hold: 0.12 },
    ],
    jitter: 0.15,
  },
  'dig.glass': {
    dur: 0.2,
    filter: { type: 'highpass', freq: 3000, q: 0.6 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.24, attack: 0.001, shape: 0.6, hold: 0.12 },
      { kind: 'sine', freq: 2150, freqEnd: 2600, peak: 0.12, attack: 0.001, shape: 0.85, hold: 0.09 },
      { kind: 'sine', freq: 3120, freqEnd: 3600, peak: 0.08, attack: 0.001, shape: 0.85, hold: 0.06, delay: 0.02 },
    ],
    jitter: 0.12,
  },
  'dig.cloth': {
    dur: 0.1,
    filter: { type: 'lowpass', freq: 900, freqEnd: 420, q: 0.6, sweep: 0.1 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.3, attack: 0.01, shape: 0.75, hold: 0.08 }],
    jitter: 0.18,
  },

  /* ---------------- breaking: dig + a crumbling tail ------------------ */
  'break.stone': {
    dur: 0.34,
    filter: { type: 'bandpass', freq: 980, freqEnd: 420, q: 1.1, sweep: 0.3 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.5, attack: 0.002, shape: 0.45, hold: 0.24 },
      { kind: 'triangle', freq: 140, freqEnd: 92, peak: 0.2, attack: 0.002, shape: 1, hold: 0.14 },
      { kind: 'noise', freq: 1, peak: 0.16, attack: 0.002, shape: 0.7, hold: 0.08, delay: 0.09 },
    ],
    jitter: 0.14,
  },
  'break.dirt': {
    dur: 0.26,
    filter: { type: 'lowpass', freq: 1000, freqEnd: 380, q: 0.7, sweep: 0.24 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.44, attack: 0.005, shape: 0.5, hold: 0.2 },
      { kind: 'sine', freq: 126, freqEnd: 74, peak: 0.2, attack: 0.002, shape: 1, hold: 0.13 },
    ],
    jitter: 0.16,
  },
  'break.grass': {
    dur: 0.2,
    filter: { type: 'highpass', freq: 1900, freqEnd: 3000, q: 0.6, sweep: 0.2 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.3, attack: 0.004, shape: 0.6, hold: 0.16 },
      { kind: 'triangle', freq: 300, freqEnd: 190, peak: 0.07, attack: 0.002, shape: 1, hold: 0.08 },
    ],
    jitter: 0.2,
  },
  'break.sand': {
    dur: 0.22,
    filter: { type: 'highpass', freq: 1600, freqEnd: 2500, q: 0.5, sweep: 0.22 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.3, attack: 0.02, shape: 0.8, hold: 0.19 }],
    jitter: 0.22,
  },
  'break.gravel': {
    dur: 0.3,
    filter: { type: 'bandpass', freq: 1500, freqEnd: 600, q: 1, sweep: 0.28 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.46, attack: 0.002, shape: 0.45, hold: 0.2 },
      { kind: 'noise', freq: 1, peak: 0.24, attack: 0.001, shape: 0.6, hold: 0.07, delay: 0.04 },
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.001, shape: 0.6, hold: 0.06, delay: 0.1 },
    ],
    jitter: 0.2,
  },
  'break.wood': {
    dur: 0.3,
    filter: { type: 'bandpass', freq: 900, freqEnd: 400, q: 1.2, sweep: 0.28 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.36, attack: 0.002, shape: 0.5, hold: 0.2 },
      { kind: 'triangle', freq: 210, freqEnd: 118, peak: 0.3, attack: 0.002, shape: 0.95, hold: 0.24 },
      { kind: 'triangle', freq: 320, freqEnd: 200, peak: 0.12, attack: 0.002, shape: 2, hold: 0.1, delay: 0.05 },
    ],
    jitter: 0.14,
  },
  'break.glass': {
    dur: 0.38,
    filter: { type: 'highpass', freq: 2800, q: 0.6 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.34, attack: 0.001, shape: 0.5, hold: 0.26 },
      { kind: 'sine', freq: 2400, freqEnd: 1900, peak: 0.14, attack: 0.001, shape: 0.9, hold: 0.16 },
      { kind: 'sine', freq: 3300, freqEnd: 2700, peak: 0.1, attack: 0.001, shape: 1.5, hold: 0.1, delay: 0.045 },
      { kind: 'sine', freq: 4150, freqEnd: 3600, peak: 0.07, attack: 0.001, shape: 2, hold: 0.07, delay: 0.11 },
    ],
    jitter: 0.12,
  },
  'break.cloth': {
    dur: 0.24,
    filter: { type: 'lowpass', freq: 880, freqEnd: 340, q: 0.6, sweep: 0.22 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.38, attack: 0.008, shape: 0.65, hold: 0.2 }],
    jitter: 0.18,
  },

  /* ---------------- placing: a low thud with a click transient -------- */
  'place.stone': {
    dur: 0.19,
    filter: { type: 'lowpass', freq: 1500, freqEnd: 520, q: 0.9, sweep: 0.16 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.26, attack: 0.001, shape: 0.4, hold: 0.06 },
      { kind: 'sine', freq: 196, freqEnd: 116, peak: 0.32, attack: 0.002, shape: 1.2, hold: 0.16 },
    ],
    jitter: 0.12,
  },
  'place.wood': {
    dur: 0.21,
    filter: { type: 'lowpass', freq: 1250, freqEnd: 430, q: 1, sweep: 0.18 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.001, shape: 0.4, hold: 0.05 },
      { kind: 'triangle', freq: 232, freqEnd: 138, peak: 0.34, attack: 0.002, shape: 1.1, hold: 0.18 },
    ],
    jitter: 0.12,
  },
  'place.dirt': {
    dur: 0.17,
    filter: { type: 'lowpass', freq: 960, freqEnd: 380, q: 0.7, sweep: 0.15 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.24, attack: 0.002, shape: 0.5, hold: 0.07 },
      { kind: 'sine', freq: 142, freqEnd: 88, peak: 0.26, attack: 0.002, shape: 1.2, hold: 0.14 },
    ],
    jitter: 0.16,
  },
  'place.sand': {
    dur: 0.16,
    filter: { type: 'lowpass', freq: 1150, freqEnd: 520, q: 0.4, sweep: 0.14 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.006, shape: 0.6, hold: 0.1 },
      { kind: 'sine', freq: 128, freqEnd: 86, peak: 0.18, attack: 0.003, shape: 1.2, hold: 0.12 },
    ],
    jitter: 0.18,
  },

  /* ---------------- feedback / interaction --------------------------- */
  pop: {
    dur: 0.14,
    sources: [
      {
        kind: 'sine', freq: 420, freqEnd: 1180, bend: 'exp', bendTime: 0.075,
        peak: 0.34, attack: 0.003, shape: 1.1, hold: 0.11, am: 0.1, amRate: 42,
      },
    ],
    jitter: 0.08,
  },
  hurt: {
    dur: 0.3,
    filter: { type: 'lowpass', freq: 1900, freqEnd: 900, q: 0.8, sweep: 0.24 },
    sources: [
      {
        kind: 'square', freq: 330, freqEnd: 150, bend: 'exp', bendTime: 0.22,
        peak: 0.3, attack: 0.003, shape: 1.1, hold: 0.25, fm: 22, fmRatio: 2.01, fmDecay: 0.18, am: 0.28, amRate: 17,
      },
      { kind: 'sawtooth', freq: 168, freqEnd: 96, peak: 0.12, attack: 0.004, shape: 1.2, hold: 0.2 },
    ],
    jitter: 0.1,
  },
  'mob.hurt': {
    // Deliberately forward in the mix: this is the only confirmation the player
    // gets that an attack connected, and at the old peaks it was easy to miss
    // under footsteps and block sounds, which reads as "did I even hit it?".
    dur: 0.28,
    filter: { type: 'bandpass', freq: 820, freqEnd: 540, q: 1.0, sweep: 0.24 },
    sources: [
      {
        kind: 'sawtooth', freq: 300, freqEnd: 168, bend: 'exp', bendTime: 0.2,
        peak: 0.34, attack: 0.005, shape: 1.2, hold: 0.22, am: 0.34, amRate: 23,
      },
      { kind: 'noise', freq: 1, peak: 0.22, attack: 0.003, shape: 0.65, hold: 0.12 },
    ],
    jitter: 0.14,
  },
  'mob.death': {
    dur: 0.62,
    filter: { type: 'lowpass', freq: 1300, freqEnd: 320, q: 0.9, sweep: 0.55 },
    sources: [
      {
        kind: 'sawtooth', freq: 260, freqEnd: 74, bend: 'exp', bendTime: 0.5,
        peak: 0.26, attack: 0.006, shape: 1.1, hold: 0.55, am: 0.4, amRate: 15,
      },
      { kind: 'noise', freq: 1, peak: 0.14, attack: 0.01, shape: 0.8, hold: 0.4 },
    ],
    jitter: 0.1,
  },
  'mob.idle': {
    dur: 0.4,
    filter: { type: 'lowpass', freq: 900, q: 0.6 },
    sources: [
      {
        kind: 'triangle', freq: 180, freqEnd: 232, bend: 'exp', bendTime: 0.18,
        peak: 0.14, attack: 0.05, shape: 1.6, hold: 0.32, am: 0.2, amRate: 11,
      },
      { kind: 'noise', freq: 1, peak: 0.05, attack: 0.08, shape: 1.6, hold: 0.28, delay: 0.04 },
    ],
    jitter: 0.18,
  },

  /* ---------------- liquids ------------------------------------------ */
  splash: {
    dur: 0.5,
    filter: { type: 'lowpass', freq: 420, freqEnd: 3600, q: 0.9, sweep: 0.16 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.36, attack: 0.004, shape: 0.6, hold: 0.34 },
      {
        kind: 'sine', freq: 300, freqEnd: 720, bend: 'exp', bendTime: 0.14,
        peak: 0.12, attack: 0.01, shape: 1.1, hold: 0.22, delay: 0.03,
      },
    ],
    jitter: 0.16,
  },
  swim: {
    dur: 0.34,
    filter: { type: 'lowpass', freq: 700, freqEnd: 1500, q: 0.5, sweep: 0.3 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.16, attack: 0.05, shape: 0.9, hold: 0.26 },
      { kind: 'sine', freq: 190, freqEnd: 150, peak: 0.07, attack: 0.02, shape: 1.4, hold: 0.24 },
    ],
    jitter: 0.2,
  },
  fizz: {
    dur: 0.55,
    filter: { type: 'highpass', freq: 2600, freqEnd: 4200, q: 0.6, sweep: 0.5 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.16, attack: 0.02, shape: 1.3, hold: 0.48 }],
    jitter: 0.16,
  },

  /* ---------------- combat / destruction ----------------------------- */
  explosion: {
    dur: 1.9,
    filter: { type: 'lowpass', freq: 950, freqEnd: 90, q: 0.8, sweep: 1.5 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.75, attack: 0.006, shape: 0.4, hold: 1.5 },
      { kind: 'sine', freq: 78, freqEnd: 24, peak: 0.55, attack: 0.004, shape: 0.9, hold: 1.25 },
      { kind: 'sine', freq: 41, freqEnd: 19, peak: 0.3, attack: 0.01, shape: 1.1, hold: 0.95 },
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.04, shape: 1.4, hold: 0.9, delay: 0.22 },
    ],
    jitter: 0.1,
  },
  bow: {
    dur: 0.34,
    filter: { type: 'bandpass', freq: 1500, freqEnd: 640, q: 2.2, sweep: 0.28 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.32, attack: 0.002, shape: 0.5, hold: 0.26 },
      { kind: 'triangle', freq: 720, freqEnd: 190, peak: 0.12, attack: 0.002, shape: 1.3, hold: 0.26 },
    ],
    jitter: 0.14,
  },

  /* ---------------- UI ----------------------------------------------- */
  click: {
    dur: 0.035,
    filter: { type: 'bandpass', freq: 2400, q: 1.6 },
    sources: [{ kind: 'noise', freq: 1, peak: 0.24, attack: 0.001, shape: 0.5, hold: 0.03 }],
    jitter: 0.1,
  },
  button: {
    dur: 0.095,
    filter: { type: 'bandpass', freq: 1250, q: 1.1 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.002, shape: 0.55, hold: 0.06 },
      { kind: 'triangle', freq: 420, freqEnd: 620, peak: 0.14, attack: 0.003, shape: 1.1, hold: 0.08 },
    ],
    jitter: 0.1,
  },
  levelup: {
    dur: 0.9,
    filter: { type: 'lowpass', freq: 5200, q: 0.5 },
    sources: [
      { kind: 'sine', freq: 523.25, peak: 0.16, attack: 0.004, shape: 1.3, hold: 0.3 },
      { kind: 'sine', freq: 659.25, peak: 0.15, attack: 0.004, shape: 1.3, hold: 0.3, delay: 0.12 },
      { kind: 'sine', freq: 783.99, peak: 0.15, attack: 0.004, shape: 1.3, hold: 0.3, delay: 0.24 },
      { kind: 'triangle', freq: 1046.5, peak: 0.13, attack: 0.006, shape: 1.4, hold: 0.34, delay: 0.36 },
      { kind: 'sine', freq: 2093.0, peak: 0.05, attack: 0.006, shape: 1.6, hold: 0.4, delay: 0.37 },
    ],
  },
  craft: {
    dur: 0.36,
    filter: { type: 'bandpass', freq: 1400, freqEnd: 700, q: 1.3, sweep: 0.3 },
    sources: [
      { kind: 'noise', freq: 1, peak: 0.24, attack: 0.002, shape: 0.5, hold: 0.07 },
      { kind: 'triangle', freq: 330, freqEnd: 220, peak: 0.2, attack: 0.002, shape: 1.1, hold: 0.12 },
      { kind: 'noise', freq: 1, peak: 0.2, attack: 0.001, shape: 0.5, hold: 0.06, delay: 0.13 },
      { kind: 'triangle', freq: 494, freqEnd: 392, peak: 0.16, attack: 0.002, shape: 1.2, hold: 0.14, delay: 0.13 },
    ],
    jitter: 0.12,
  },
};

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private unavailable = false;
  private noise: AudioBuffer | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;

  private masterVolume = 0.9;
  private sfxVolume = 1;
  private musicVolume = 0.5;

  private readonly voices: Voice[] = [];
  private readonly voicePool: Voice[] = [];

  private musicOn = false;
  private nextPadAt = -1;
  private nextBellAt = -1;
  private padIndex = 3;
  private ambient: Array<{ gain: GainNode; stop: () => void }> = [];

  /* ---------------------------------------------------------------- */

  constructor() {
    // Deliberately lazy: constructing the engine must never touch Web Audio so
    // that importing this module is safe in Node / headless QA runs.
  }

  /** Create the context + graph on first use. Never throws. */
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.unavailable) return null;
    const Ctor = findAudioContextCtor();
    if (!Ctor) {
      this.unavailable = true;
      return null;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      const sfx = ctx.createGain();
      const music = ctx.createGain();
      master.gain.value = this.masterVolume;
      sfx.gain.value = this.sfxVolume;
      music.gain.value = this.musicVolume;
      sfx.connect(master);
      music.connect(master);
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.masterGain = master;
      this.sfxGain = sfx;
      this.musicGain = music;
      return ctx;
    } catch {
      this.unavailable = true;
      this.ctx = null;
      return null;
    }
  }

  /** Must be called from a user gesture (click/keydown) to unlock the context. */
  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* autoplay refusal is not an error we can act on */
    }
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /* ---------------------------------------------------------------- */
  /* Volume                                                            */
  /* ---------------------------------------------------------------- */

  setVolumes(master: number, sfx: number, music: number): void {
    this.masterVolume = clamp01(master);
    this.sfxVolume = clamp01(sfx);
    this.musicVolume = clamp01(music);
    const ctx = this.ctx;
    if (ctx) {
      const now = ctx.currentTime;
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.02);
      if (this.sfxGain) this.sfxGain.gain.setTargetAtTime(this.sfxVolume, now, 0.02);
      if (this.musicGain) this.musicGain.gain.setTargetAtTime(this.musicVolume, now, 0.05);
    }
  }

  get volumes(): VolumeState {
    return { master: this.masterVolume, sfx: this.sfxVolume, music: this.musicVolume };
  }

  /* ---------------------------------------------------------------- */
  /* Public playback                                                   */
  /* ---------------------------------------------------------------- */

  /** Fire and forget. Safe to call before `resume()`; it simply does nothing. */
  play(name: SoundName, opts?: PlayOptions): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxGain) return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    try {
      this.render(ctx, recipe, opts);
    } catch {
      /* a failed voice must never break gameplay */
    }
  }

  /** Play the sound appropriate for a block's `SoundClass`. */
  playBlock(
    action: 'step' | 'dig' | 'break' | 'place',
    soundClass: string,
    opts?: PlayOptions,
  ): void {
    const name = blockSoundName(action, soundClass);
    if (!name) return;
    this.play(name, opts);
  }

  /** Start/stop the looping ambient bed. */
  setMusicEnabled(on: boolean): void {
    if (on === this.musicOn) return;
    this.musicOn = on;
    const ctx = this.ensure();
    if (!ctx) return;
    if (!on) {
      this.stopAmbient();
      return;
    }
    // Start scheduling almost immediately so toggling is audible right away.
    this.nextPadAt = ctx.currentTime + 0.35;
    this.nextBellAt = ctx.currentTime + 3.2 + rnd() * 3;
  }

  get musicEnabled(): boolean {
    return this.musicOn;
  }

  update(dt: number): void {
    const step = clamp(dt, 0, MAX_DT);
    const ctx = this.ctx;
    if (!ctx) return;
    this.reapVoices(ctx.currentTime);
    if (!this.musicOn || !this.musicGain || step <= 0) return;
    try {
      this.scheduleMusic(ctx, step);
    } catch {
      /* never let the ambient bed break the frame */
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.stopAmbient();
      for (const v of this.voices) stopVoiceNow(v, ctx);
      this.voices.length = 0;
      this.voicePool.length = 0;
      this.masterGain?.disconnect();
      this.sfxGain?.disconnect();
      this.musicGain?.disconnect();
      void ctx.close();
    } catch {
      /* already torn down */
    }
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.noise = null;
    this.musicOn = false;
    this.ambient = [];
  }

  /* ---------------------------------------------------------------- */
  /* Voice bookkeeping                                                 */
  /* ---------------------------------------------------------------- */

  private reapVoices(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.stopAt > now) continue;
      this.voices.splice(i, 1);
      // Every source already stopped itself at `stopAt`; release what can go
      // right now and let the short fade timer finish the rest.
      for (const n of v.nodes) {
        const s = n as AudioNode & { stop?: (when?: number) => void };
        if (typeof s.stop === 'function') continue;
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      const g = this.voicePool;
      if (g.length < MAX_VOICES) g.push(v);
    }
  }

  private takeVoice(ctx: AudioContext, gain: GainNode, stopAt: number, nodes: AudioNode[]): Voice {
    let rec = this.voicePool.pop();
    if (!rec) rec = { nodes: [], gain, stopAt, startedAt: 0 };
    rec.gain = gain;
    rec.stopAt = stopAt;
    rec.startedAt = ctx.currentTime;
    rec.nodes.length = 0;
    for (let i = 0; i < nodes.length; i++) rec.nodes.push(nodes[i]);

    if (this.voices.length >= MAX_VOICES) {
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) {
        if (this.voices[i].startedAt < this.voices[oldest].startedAt) oldest = i;
      }
      const victim = this.voices[oldest];
      this.voices.splice(oldest, 1);
      fadeAndStop(victim, ctx, 0.02, 0.05);
    }
    this.voices.push(rec);
    return rec;
  }

  /* ---------------------------------------------------------------- */
  /* Shared buffers / nodes                                            */
  /* ---------------------------------------------------------------- */

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    const cached = this.noise;
    if (cached) return cached;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // white noise, DC-free, slightly quantised to keep it crisp rather than hissy
    for (let i = 0; i < frames; i++) {
      const v = (rnd() * 2 - 1) * 0.92;
      d[i] = Math.round(v * 2048) / 2048;
    }
    this.noise = buf;
    return buf;
  }

  private panner(ctx: AudioContext, pan: number): AudioNode | null {
    const anyCtx = ctx as AudioContext & { createStereoPanner?: () => StereoPannerNode };
    if (typeof anyCtx.createStereoPanner !== 'function') return null;
    try {
      const p = anyCtx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      return p;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  private render(ctx: AudioContext, recipe: Recipe, opts?: PlayOptions): void {
    const bus = this.sfxGain;
    if (!bus) return;

    const volume = clamp(opts?.volume ?? 1, 0, 4);
    const pitch = clamp(opts?.pitch ?? 1, 0.05, 8);
    const pan = clamp(opts?.pan ?? 0, -1, 1);
    if (volume <= 0) return;

    const t0 = ctx.currentTime;
    const dur = Math.max(0.02, recipe.dur / pitch);
    const jitter = recipe.jitter ?? 0;
    const rate = pitch * (jitter > 0 ? 1 + (rnd() * 2 - 1) * jitter : 1);

    // Per-voice mix gain: volume envelope targets are scaled by this.
    const mix = ctx.createGain();
    mix.gain.value = volume * 0.9;

    const nodes: AudioNode[] = [mix];
    let head: AudioNode = mix;

    if (recipe.filter) {
      const f = ctx.createBiquadFilter();
      f.type = recipe.filter.type;
      const q = recipe.filter.q ?? 1;
      if (f.Q) f.Q.value = q;
      const f0 = clamp(recipe.filter.freq * rate, 20, 18000);
      f.frequency.value = f0;
      if (recipe.filter.freqEnd !== undefined) {
        const f1 = clamp(recipe.filter.freqEnd * rate, 20, 18000);
        const sweep = Math.max(0.01, (recipe.filter.sweep ?? dur) / pitch);
        f.frequency.setValueAtTime(f0, t0);
        f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + sweep);
      }
      mix.connect(f);
      nodes.push(f);
      head = f;
    }

    const panNode = this.panner(ctx, pan);
    if (panNode) {
      head.connect(panNode);
      panNode.connect(bus);
      nodes.push(panNode);
    } else {
      head.connect(bus);
    }

    let stopAt = t0 + 0.05;
    for (let i = 0; i < recipe.sources.length; i++) {
      const res = this.renderSource(ctx, recipe.sources[i], head, t0, dur, rate, pitch);
      if (res.stop > stopAt) stopAt = res.stop;
      // Every started source is tracked, modulators included, so a stolen voice
      // or dispose() can both stop them and release the whole sub-graph.
      for (let k = 0; k < res.nodes.length; k++) nodes.push(res.nodes[k]);
    }

    this.takeVoice(ctx, mix, stopAt, nodes);
  }

  /**
   * Render one oscillator/noise layer.
   * Returns when it finishes plus every source node that must later be stopped.
   */
  private renderSource(
    ctx: AudioContext,
    spec: SourceSpec,
    dest: AudioNode,
    t0: number,
    dur: number,
    rate: number,
    pitch: number,
  ): { stop: number; nodes: AudioNode[] } {
    const delay = (spec.delay ?? 0) / pitch;
    const start = t0 + delay;
    const attack = Math.max(0.0008, (spec.attack ?? 0.004) / pitch);
    const hold = Math.max(0.02, (spec.hold ?? dur - (spec.delay ?? 0)) / pitch);
    const peak = Math.max(FLOOR, spec.peak);
    const shape = Math.max(0, spec.shape ?? 0.7);
    const release = start + attack + hold;
    const stop = release + 0.04;
    const tracked: AudioNode[] = [];

    const g = ctx.createGain();
    g.gain.setValueAtTime(FLOOR, t0);
    g.gain.setValueAtTime(FLOOR, start);
    // Percussive (shape 0) is a fast exponential decay; higher shapes hold their
    // level and fall away more slowly, like a plucked or bowed note.
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    const decayAt = release - Math.min(hold * 0.25, 0.09);
    g.gain.exponentialRampToValueAtTime(peak * (1 - 0.55 * Math.min(1, shape)), Math.max(start + attack + 0.002, decayAt));
    g.gain.exponentialRampToValueAtTime(FLOOR, release);
    g.gain.setValueAtTime(0, stop);
    g.connect(dest);

    let src: AudioScheduledSourceNode;
    if (spec.kind === 'noise') {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer(ctx);
      n.loop = true;
      n.playbackRate.value = clamp(rate * (0.94 + rnd() * 0.12), 0.25, 4);
      // start from a random offset so repeated hits never sound identical
      const offset = rnd() * Math.max(0.001, NOISE_SECONDS - 0.6);
      n.start(start, offset);
      n.stop(stop);
      src = n;
    } else {
      const o = ctx.createOscillator();
      o.type = spec.kind;
      const f0 = clamp(spec.freq * rate, 8, 20000);
      o.frequency.setValueAtTime(f0, start);
      const bendTime = (spec.bendTime ?? Math.min(hold, 0.3)) / pitch;
      if (spec.freqEnd !== undefined && spec.freqEnd !== spec.freq) {
        const f1 = clamp(Math.max(8, spec.freqEnd * rate), 8, 20000);
        if ((spec.bend ?? 'exp') === 'lin') o.frequency.linearRampToValueAtTime(f1, start + bendTime);
        else o.frequency.exponentialRampToValueAtTime(f1, start + bendTime);
      }

      if (spec.fm && spec.fm > 0) {
        const mod = ctx.createOscillator();
        mod.type = 'sine';
        mod.frequency.value = clamp(f0 * (spec.fmRatio ?? 1), 1, 20000);
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(f0 * spec.fm, start);
        depth.gain.exponentialRampToValueAtTime(Math.max(1, f0 * spec.fm * 0.02), start + (spec.fmDecay ?? hold));
        mod.connect(depth);
        depth.connect(o.frequency);
        mod.start(start);
        mod.stop(stop);
        tracked.push(mod);
      }

      if (spec.am && spec.am > 0) {
        const am = ctx.createOscillator();
        am.type = 'sine';
        am.frequency.value = clamp(spec.amRate ?? 20, 0.1, 200);
        const amDepth = ctx.createGain();
        amDepth.gain.value = Math.min(0.95, spec.am) * peak;
        am.connect(amDepth);
        amDepth.connect(g.gain);
        am.start(start);
        am.stop(stop);
        tracked.push(am);
      }

      o.start(start);
      o.stop(stop);
      src = o;
    }

    src.connect(g);
    tracked.push(src);
    // Auto-release this layer's graph as soon as its source is finished.
    src.onended = () => {
      try {
        g.disconnect();
        src.disconnect();
      } catch {
        /* already gone */
      }
    };
    return { stop, nodes: tracked };
  }

  /* ---------------------------------------------------------------- */
  /* Ambient music                                                     */
  /* ---------------------------------------------------------------- */

  private scheduleMusic(ctx: AudioContext, dt: number): void {
    const bus = this.musicGain;
    if (!bus) return;
    const now = ctx.currentTime;
    if (this.nextPadAt < 0) this.nextPadAt = now + 0.4;
    if (this.nextBellAt < 0) this.nextBellAt = now + 4;

    // Guard against a stalled tab producing a burst of scheduled chords.
    if (this.nextPadAt < now - 1) this.nextPadAt = now + 0.4;
    if (this.nextBellAt < now - 1) this.nextBellAt = now + 2;

    let guard = 0;
    while (this.nextPadAt <= now + dt && guard++ < 4) {
      this.pad(ctx, bus, this.nextPadAt);
      this.nextPadAt += PAD_INTERVAL;
      this.padIndex++;
    }
    guard = 0;
    while (this.nextBellAt <= now + dt && guard++ < 4) {
      if (rnd() < BELL_CHANCE) this.bell(ctx, bus, this.nextBellAt);
      this.nextBellAt += BELL_INTERVAL * (0.6 + rnd() * 0.9);
    }
  }

  private trackAmbient(gain: GainNode, stop: () => void): void {
    this.ambient.push({ gain, stop });
    if (this.ambient.length > 48) this.ambient.splice(0, this.ambient.length - 48);
  }

  /** Long-attack, long-release pad: three detuned voices a fifth-ish apart. */
  private pad(ctx: AudioContext, bus: GainNode, at: number): void {
    const i = ((this.padIndex % (SCALE.length - 3)) + (SCALE.length - 3)) % (SCALE.length - 3);
    const hz = SCALE[i];
    const hold = 5.5 + rnd() * 3.5;
    const attack = 3.4;
    const release = 4.2;
    const dur = hold + release;

    const env = ctx.createGain();
    env.gain.setValueAtTime(FLOOR, at);
    env.gain.linearRampToValueAtTime(0.16, at + attack);
    env.gain.setValueAtTime(0.16, at + hold);
    env.gain.exponentialRampToValueAtTime(FLOOR, at + dur);
    env.gain.setValueAtTime(0, at + dur + 0.05);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    if (lp.Q) lp.Q.value = 0.4;

    env.connect(lp);
    lp.connect(bus);

    const stopAt = at + dur + 0.1;
    const detunes = [0, 6.5, -7.5];
    const partials = [1, 1.5, 2.002];
    const oscs: OscillatorNode[] = [];
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator();
      o.type = v === 1 ? 'triangle' : 'sine';
      o.frequency.value = hz * partials[v];
      o.detune.value = detunes[v];
      const vg = ctx.createGain();
      vg.gain.value = v === 0 ? 1 : v === 1 ? 0.35 : 0.22;
      o.connect(vg);
      vg.connect(env);
      o.start(at);
      o.stop(stopAt);
      oscs.push(o);
    }

    this.trackAmbient(env, () => {
      for (const o of oscs) {
        try {
          o.stop();
          o.disconnect();
        } catch {
          /* already stopped */
        }
      }
      try {
        lp.disconnect();
        env.disconnect();
      } catch {
        /* already gone */
      }
    });
  }

  /** Occasional soft bell from the same pentatonic set, an octave up. */
  private bell(ctx: AudioContext, bus: GainNode, at: number): void {
    const i = ((this.padIndex * 3 + 2) % SCALE.length + SCALE.length) % SCALE.length;
    const hz = SCALE[i] * 2;
    const life = 3.2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(FLOOR, at);
    env.gain.exponentialRampToValueAtTime(0.075, at + 0.012);
    env.gain.exponentialRampToValueAtTime(FLOOR, at + life);
    env.gain.setValueAtTime(0, at + life + 0.03);
    env.connect(bus);

    const stopAt = at + life + 0.1;
    const oscs: OscillatorNode[] = [];
    const ratios = [1, 2.01, 3.03];
    const levels = [1, 0.34, 0.14];
    for (let v = 0; v < ratios.length; v++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz * ratios[v];
      const vg = ctx.createGain();
      vg.gain.value = levels[v];
      o.connect(vg);
      vg.connect(env);
      o.start(at);
      o.stop(stopAt);
      oscs.push(o);
    }

    this.trackAmbient(env, () => {
      for (const o of oscs) {
        try {
          o.stop();
          o.disconnect();
        } catch {
          /* already stopped */
        }
      }
      try {
        env.disconnect();
      } catch {
        /* already gone */
      }
    });
  }

  private stopAmbient(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.ambient = [];
      return;
    }
    const now = ctx.currentTime;
    const list = this.ambient;
    this.ambient = [];
    for (const a of list) {
      try {
        const v = a.gain.gain.value;
        const from = v > FLOOR ? v : FLOOR;
        a.gain.gain.cancelScheduledValues(now);
        a.gain.gain.setValueAtTime(from, now);
        a.gain.gain.exponentialRampToValueAtTime(FLOOR, now + 0.4);
      } catch {
        /* ignore */
      }
      const stopFn = a.stop;
      setTimeout(() => {
        try {
          stopFn();
        } catch {
          /* ignore */
        }
      }, 500);
    }
    this.nextPadAt = -1;
    this.nextBellAt = -1;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Fade a stolen voice out quickly, then stop and release its nodes. */
function fadeAndStop(v: Voice, ctx: AudioContext, fade: number, tail: number): void {
  const now = ctx.currentTime;
  try {
    const current = v.gain.gain.value;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(current > FLOOR ? current : FLOOR, now);
    v.gain.gain.exponentialRampToValueAtTime(FLOOR, now + fade);
  } catch {
    /* ignore */
  }
  for (const n of v.nodes) {
    const s = n as AudioNode & { stop?: (when?: number) => void };
    if (typeof s.stop === 'function') {
      try {
        s.stop(now + fade + tail);
      } catch {
        /* a stopped source throws in some engines; harmless */
      }
    }
  }
  const timer = setTimeout(() => {
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }, (fade + tail) * 1000 + 120);
  void timer;
}
/** Immediate teardown used by `dispose()`. */
function stopVoiceNow(v: Voice, ctx: AudioContext): void {
  for (const n of v.nodes) {
    const s = n as AudioNode & { stop?: (when?: number) => void };
    // A source that was started but never stopped keeps running headlessly, so
    // make sure dispose() silences it as well as unplugging it.
    if (typeof s.stop === 'function') {
      try {
        s.stop();
      } catch {
        /* never started, or already stopped: harmless */
      }
    }
    try {
      n.disconnect();
    } catch {
      /* ignore */
    }
  }
  try {
    v.gain.gain.cancelScheduledValues(ctx.currentTime);
    v.gain.gain.value = 0;
  } catch {
    /* ignore */
  }
}

/**
 * Map a block `SoundClass` onto a concrete sound. Classes without a dedicated
 * set (plants, liquids) borrow the closest-sounding material instead of
 * producing silence.
 */
function blockSoundName(action: 'step' | 'dig' | 'break' | 'place', soundClass: string): SoundName | null {
  if (action === 'place') {
    switch (soundClass) {
      case 'wood':
      case 'plant':
        return 'place.wood';
      case 'sand':
        return 'place.sand';
      case 'dirt':
      case 'grass':
      case 'gravel':
      case 'cloth':
        return 'place.dirt';
      case 'liquid':
        return null;
      default:
        return 'place.stone';
    }
  }

  const key = action === 'step' ? 'step' : action === 'dig' ? 'dig' : 'break';
  let material: string;
  switch (soundClass) {
    case 'stone':
    case 'dirt':
    case 'grass':
    case 'sand':
    case 'gravel':
    case 'wood':
    case 'glass':
    case 'cloth':
      material = soundClass;
      break;
    case 'plant':
      material = 'grass';
      break;
    case 'liquid':
      material = 'sand';
      break;
    default:
      material = 'stone';
      break;
  }
  const name = `${key}.${material}` as SoundName;
  return name in RECIPES ? name : null;
}

/** Module-level singleton used by the game. */
export const audio = new AudioEngine();
