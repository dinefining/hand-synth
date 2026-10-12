import { NOTE_LETTERS } from './constants';
import type { ScaleName } from './constants';

export type Side = 'synth' | 'arp';
export type LoopState = 'empty' | 'armed' | 'recording' | 'playing';
export type ArpPattern = 'up' | 'down' | 'updown' | 'random';
// 'osc' is the plain oscillator; 'mine' is the side's SAM sound, picked from the library or loaded from a file
export type SoundName = 'osc' | 'pluck' | 'bell' | 'keys' | 'mine';

export interface Settings {
    key: number; // root, in semitones above C
    scale: ScaleName;
    synthSound: SoundName;
    synthVolume: number;
    waveform: OscillatorType;
    octave: number;
    sustain: number; // seconds a synth note holds after the finger leaves, and its fade time constant
    arpSound: SoundName;
    arpVolume: number;
    bpm: number; // arpeggio steps are eighth notes
    pattern: ArpPattern;
    noteLength: number; // seconds
}

export const DEFAULT_SETTINGS: Settings = {
    key: 9, // A
    scale: 'mixo',
    synthSound: 'osc',
    synthVolume: 1,
    waveform: 'square',
    octave: 0,
    sustain: 1,
    arpSound: 'osc',
    arpVolume: 1,
    bpm: 150,
    pattern: 'up',
    noteLength: 0.5,
};

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

interface RangeControl {
    kind: 'range';
    label: string;
    min: number;
    max: number;
    get: (s: Settings) => number;
    set: (s: Settings, v: number) => void;
    format: (v: number) => string;
}

interface ChoiceControl {
    kind: 'choice';
    label: string;
    names: readonly string[];
    getIndex: (s: Settings) => number;
    setIndex: (s: Settings, i: number) => void;
    format: (s: Settings) => string;
}

interface LoopControl {
    kind: 'loop';
    label: string;
}

export type Control = RangeControl | ChoiceControl | LoopControl;

const range = (label: string, key: NumericKey, min: number, max: number, format: (v: number) => string): RangeControl => ({
    kind: 'range', label, min, max, format,
    get: s => s[key],
    set: (s, v) => { (s as Record<NumericKey, number>)[key] = v; },
});

const choice = <K extends keyof Settings>(label: string, key: K, options: readonly Settings[K][], names: readonly string[]): ChoiceControl => ({
    kind: 'choice', label, names,
    getIndex: s => options.indexOf(s[key]),
    setIndex: (s, i) => { s[key] = options[i]; },
    format: s => names[options.indexOf(s[key])],
});

const percent = (v: number) => `${Math.round(v * 100)}%`;
const LOOP: LoopControl = { kind: 'loop', label: 'LOOP' };
const SOUNDS: SoundName[] = ['osc', 'pluck', 'bell', 'keys', 'mine'];
// MORE opens the sound picker for that side (it's drawn underlined, as a link-like option)
export const SAMPLE_OPTION = 'MORE';
const SOUND_NAMES = ['OSC', 'PLUCK', 'BELL', 'KEYS', SAMPLE_OPTION];

// Top to bottom, as the slots appear in each side panel. KEY and SCALE apply to both sides.
export const CONTROLS: Record<Side, Control[]> = {
    synth: [
        choice('SCALE', 'scale', ['maj', 'min', 'pent', 'mpent', 'blues', 'mixo'], ['MAJ', 'MIN', 'PENT', 'mPENT', 'BLUES', 'MIXO']),
        choice('SAMP', 'synthSound', SOUNDS, SOUND_NAMES),
        range('VOL', 'synthVolume', 0, 2, percent),
        choice('WAVE', 'waveform', ['square', 'sawtooth', 'sine', 'triangle'], ['SQR', 'SAW', 'SIN', 'TRI']),
        choice('OCT', 'octave', [-2, -1, 0, 1, 2], ['-2', '-1', '0', '+1', '+2']),
        range('SUST', 'sustain', 0.1, 3, v => v.toFixed(1)),
        LOOP,
    ],
    arp: [
        choice('KEY', 'key', NOTE_LETTERS.map((_, i) => i), NOTE_LETTERS),
        choice('SAMP', 'arpSound', SOUNDS, SOUND_NAMES),
        range('VOL', 'arpVolume', 0, 2, percent),
        range('BPM', 'bpm', 60, 240, v => `${Math.round(v)}`),
        choice('PATT', 'pattern', ['up', 'down', 'updown', 'random'], ['UP', 'DN', 'UP/DN', 'RAND']),
        range('LEN', 'noteLength', 0.05, 1.5, v => v.toFixed(2)),
        LOOP,
    ],
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Sets a range control from a 0-1 position along its track
export const setFraction = (control: RangeControl, s: Settings, fraction: number) =>
    control.set(s, control.min + clamp(fraction, 0, 1) * (control.max - control.min));

export const formatControl = (control: Control, s: Settings): string =>
    control.kind === 'range' ? control.format(control.get(s)) : control.kind === 'choice' ? control.format(s) : '';

// Where a range control's value sits between its min and max, for the slot's level bar
export const controlFraction = (control: Control, s: Settings): number | null =>
    control.kind === 'range' ? (control.get(s) - control.min) / (control.max - control.min) : null;
