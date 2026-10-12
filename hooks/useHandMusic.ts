import { useEffect, useRef, RefObject } from 'react';
import type { Landmark, Results } from '../types';
import { GRID_ROWS, GRID_COLUMNS, FINGERTIP_INDICES, HAND_CONNECTIONS, midiToFreq, midiToName, noteMidi } from '../constants';
import { CONTROLS, DEFAULT_SETTINGS, SAMPLE_OPTION, controlFraction, formatControl, setFraction } from '../controls';
import type { LoopState, Settings, Side } from '../controls';
import { SAMPLE_BASE_FREQ, SAMPLE_LIBRARY, createWavRecorder, makeBuiltInSamples } from '../audio';
import type { BuiltInSample, WavRecorder } from '../audio';
import { createHalftone } from '../halftone';
import { createHandSmoother } from '../smoothing';
import type { Rgb } from '../halftone';


const FILL_FRACTION = 0.74; // how much of the window the grid and its side slots may fill (landscape)
// Upright (portrait) screens stack the halves: arpeggio on top, synth below, with a button row above and below
const PORTRAIT_FILL_W = 0.94;
const PORTRAIT_FILL_H = 0.84;
const FIST_HOLD_MS = 400; // a fist must be held this long before it counts
// Once the controls are open, they stay open until the fist hand has mostly opened for this long,
// or been out of view for longer, and never while a pinch is adjusting a row
const OPEN_HOLD_MS = 500;
const LOST_HOLD_MS = 1000;
// Thumb-to-index distance, relative to hand size, that starts and ends a pinch
const PINCH_ON = 0.3;
const PINCH_OFF = 0.45;
const PINCH_PRESS_MS = 60; // fingers must stay together this long before a pinch counts
const PINCH_RELEASE_MS = 80; // and apart this long to let go
const POINTER_LOST_MS = 300; // brief tracking dropouts of the pinching hand are ignored
// When pinching controls or the picker, the cursor moves this much further than the hand (from the grid's
// centre), so the edge rows are reachable with the whole hand still in the camera's view
const REACH_GAIN = 1.3;
const SYNTH_RECORD_THROTTLE_MS = 50;
// The horns gesture (recording) fires after being held this long, and re-arms once the hand has left the
// shape for a moment. Brief tracking gaps shorter than GESTURE_GAP_MS don't reset the hold.
const GESTURE_HOLD_MS = 600;
const GESTURE_RELEASE_MS = 400;
const GESTURE_GAP_MS = 200;
const COUNTDOWN_MS = 5000;
const MIN_LOOP_MS = 250;
const FLASH_MS = 180;


const SIDES: Side[] = ['synth', 'arp'];

// Design tokens for the control surfaces
const FONT = 'VT323, monospace';
const BG = '#ffffff';
const SURFACE = '#f1f1f1';
const SURFACE_HOVER = '#e8e8e8';
const INK_NEUTRAL = '#ffffff';
const TRACK = '#ff3b2f'; // hand tracking: signal red, readable over the grey halftone and the white page
// Half-widths of the pinch square, fully open and pinched (the LOCK disc uses the open size)
const CURSOR_MAX = 40;
const CURSOR_MIN = 10;
// The camera as a grey dot-print halftone instead of the plain image (off for now)
const HALFTONE = false;
const HALFTONE_INK: Rgb = [150, 150, 146];

// The accent on the grey surfaces, the same on both sides: yellow levels and chosen options under black text.
// fill: slider levels, chosen options, played cells; ink: text and halftone dots; inkStrong: text on the
// focused row or open panel. The rgb forms are for drawing with alpha. (Kept per side so they can differ again.)
interface Palette { fill: string; ink: string; inkStrong: string; fillRgb: string; inkRgb: Rgb }
// Dark grey rather than black text keeps it easy to read without harsh contrast (~8:1 on the grey, ~6:1 on yellow)
const YELLOW: Palette = { fill: '#f7dd4a', ink: '#4a4a4a', inkStrong: '#2e2e2e', fillRgb: '247, 221, 74', inkRgb: [74, 74, 74] };
const PALETTE: Record<Side, Palette> = { arp: YELLOW, synth: YELLOW };
const REC = '#e0524a';
// The sound picker
const LOAD_HOVER = '#4c4c4c';
const PICKER_FRAME = '#9a9a9a';
const SIDE_NAME: Record<Side, string> = { arp: 'ARPEGGIO', synth: 'SYNTH' };
const HALF_LABEL = '#bdbdbd'; // ARPEGGIOS / SYNTHS
const NOTE_INK = '#444444'; // note names in the cells
// Text height of the small tags (labels, MENU, RECORDING) and of the note names, in cells
const TAG_SIZE = 0.2;
const NOTE_TAG_SIZE = 0.15;

interface Voice {
    src: OscillatorNode | AudioBufferSourceNode;
    gain: GainNode;
    buffer: AudioBuffer | null; // null for an oscillator voice
    released: boolean;
    timeout?: ReturnType<typeof setTimeout>;
}

interface Samples {
    builtIn: Record<BuiltInSample, AudioBuffer> | null;
    mine: Partial<Record<Side, AudioBuffer>>;
}

// Loops store cells rather than pitches, so they follow key and scale changes
interface LoopEvent { t: number; row: number; col: number }

interface Loop {
    state: LoopState;
    events: LoopEvent[];
    start: number; // when recording began, or when playback's first pass began
    length: number;
    lastPos: number;
}

interface FistTrack {
    rawSince: number | null;
    releaseSince: number | null;
    confirmed: boolean;
    closedAt: number; // when the confirmed fist first started closing
}

interface Rect { x: number; y: number; w: number; h: number }
interface Point { x: number; y: number }
// A hand's role comes from where it is, not MediaPipe's left/right guess, which is unreliable
// (especially for fists). The hand further left on screen plays the arpeggio, the other the synth.
interface Hand { landmarks: Landmark[]; role: Side }
interface Cursor { point: Point; ratio: number; pinching: boolean }
type Layout = ReturnType<typeof getLayout>;

const emptyLoop = (): Loop => ({ state: 'empty', events: [], start: 0, length: 0, lastPos: 0 });


// Everything is laid out on one square cell: the note grid, the side slots, and the control rows.
// Every tile is its cell inset by half a line, so lines of one width separate everything, including
// the two halves of the grid. Sizes are in device pixels on whole-pixel edges, so lines stay crisp.
//
// Landscape: the halves sit side by side (arpeggio left, synth right) and each side's buttons are a
// column beside it; within a half, columns are the scale's notes and rows are octaves.
// Portrait: the grid turns, halves stacked (arpeggio on top), buttons in a row above and below;
// within a half, the notes run bottom to top and octaves left to right.
const getLayout = (W: number, H: number) => {
    const portrait = H > W;
    const n = CONTROLS.synth.length;
    const cols = portrait ? GRID_ROWS : GRID_COLUMNS;
    const rows = portrait ? GRID_COLUMNS : GRID_ROWS;
    const cell = portrait
        ? Math.floor(Math.min((W * PORTRAIT_FILL_W) / cols, (H * PORTRAIT_FILL_H) / (rows + 2)))
        : Math.floor(Math.min((H * FILL_FRACTION) / rows, (W * FILL_FRACTION) / (cols + 2)));
    const line = 2; // even, so half a line is still a whole pixel
    const grid = {
        x: Math.round((W - cell * cols) / 2),
        y: Math.round((H - cell * rows) / 2),
        w: cell * cols,
        h: cell * rows,
    };
    const tile = (x: number, y: number, w: number, h: number): Rect => ({ x: x + line / 2, y: y + line / 2, w: w - line, h: h - line });
    // Controls line up with the first cells of the button column (or row)
    const first = Math.max(0, (portrait ? cols : rows) - n - 1);

    // The note at (row, col), where row is the octave (0 highest) and col the camera column
    // (0-5 synth, 6-11 arpeggio), and which screen cell it occupies
    const cellOf = (row: number, col: number) => {
        if (!portrait) return { c: GRID_COLUMNS - 1 - col, r: row };
        const arp = col >= GRID_COLUMNS / 2;
        return { c: GRID_ROWS - 1 - row, r: (arp ? 5 : 11) - (col % 6) };
    };
    const noteRect = (row: number, col: number): Rect => {
        const { c, r } = cellOf(row, col);
        return { x: grid.x + c * cell, y: grid.y + r * cell, w: cell, h: cell };
    };
    const noteAt = (p: Point): { row: number; col: number } | null => {
        if (p.x < grid.x || p.x >= grid.x + grid.w || p.y < grid.y || p.y >= grid.y + grid.h) return null;
        const c = Math.floor((p.x - grid.x) / cell);
        const r = Math.floor((p.y - grid.y) / cell);
        if (!portrait) return { row: r, col: GRID_COLUMNS - 1 - c };
        const arp = r < 6;
        const note = (arp ? 5 : 11) - r;
        return { row: GRID_ROWS - 1 - c, col: arp ? 6 + note : note };
    };

    // Status slots: a column beside each half (landscape) or a row above and below (portrait)
    const slotRect = (side: Side, i: number): Rect => portrait
        ? tile(grid.x + (first + i) * cell, side === 'arp' ? grid.y - cell : grid.y + grid.h, cell, cell)
        : tile(side === 'arp' ? grid.x - cell : grid.x + grid.w, grid.y + (first + i) * cell, cell, cell);

    // While a side's controls are open, each control spans that half: a row (landscape) or a column (portrait)
    const bandRect = (side: Side, i: number): Rect => portrait
        ? tile(grid.x + (first + i) * cell, side === 'arp' ? grid.y : grid.y + grid.h / 2, cell, grid.h / 2)
        : tile(side === 'arp' ? grid.x : grid.x + grid.w / 2, grid.y + (first + i) * cell, grid.w / 2, cell);

    // Option k of n along a band (left to right, or top to bottom), separated by the same line
    const segmentRect = (band: Rect, k: number, count: number): Rect => {
        const length = portrait ? band.h : band.w;
        const start = portrait ? band.y : band.x;
        const step = (length + line) / count;
        const a = start + Math.round(k * step);
        const size = start + Math.round((k + 1) * step) - line - a;
        return portrait ? { x: band.x, y: a, w: band.w, h: size } : { x: a, y: band.y, w: size, h: band.h };
    };
    // How far along a band a point is, 0-1: left to right for everything in landscape; in portrait,
    // top to bottom for options and bottom to top for sliders (so a level rises like the slot's)
    const along = (band: Rect, p: Point, rising: boolean) => {
        if (!portrait) return (p.x - band.x) / band.w;
        const down = (p.y - band.y) / band.h;
        return rising ? 1 - down : down;
    };

    // Free space above and below everything, for the small labels and tags
    const top = portrait ? grid.y - cell : grid.y;
    const bottom = portrait ? grid.y + grid.h + cell : grid.y + grid.h;
    return { portrait, cols, rows, cell, line, grid, tile, noteRect, noteAt, slotRect, bandRect, segmentRect, along, top, bottom };
};

// Draws text stretched on both axes to fill `box`, leaving `pad` on every side
const stretchText = (ctx: CanvasRenderingContext2D, text: string, box: Rect, pad: number) => {
    const w = box.w - pad * 2;
    const h = box.h - pad * 2;
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.font = `100px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text);
    const textW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const textH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    ctx.translate(box.x + pad, box.y + pad);
    ctx.scale(w / textW, h / textH);
    ctx.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
    ctx.restore();
};

// Underlines centred text (drawn with textBaseline 'middle') in the current fill colour
const underline = (ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, size: number) => {
    const w = ctx.measureText(text).width;
    ctx.fillRect(Math.round(cx - w / 2), Math.round(cy + size * 0.36), Math.round(w), Math.max(1, Math.round(size * 0.07)));
};

// Keeps the canvas at the screen's real pixel density for its displayed size, so nothing gets resampled.
// Checked every frame, which also catches window resizes and late-loading styles.
const fitCanvas = (canvas: HTMLCanvasElement) => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
};

const contains = (r: Rect, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

// On-screen distance (depth from the tracker is too noisy to help)
const handDist = (a: Landmark, b: Landmark, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

// How many of the four fingers are curled: fingertip closer to the wrist than its middle knuckle
const curledFingers = (lm: Landmark[], aspect: number) =>
    [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) => handDist(lm[tip], lm[0], aspect) < handDist(lm[pip], lm[0], aspect)).length;

// The palm's size, measured both lengthwise and across so tilting the hand doesn't shrink it
const palmSize = (lm: Landmark[], aspect: number) =>
    Math.max(1e-6, handDist(lm[0], lm[9], aspect), handDist(lm[5], lm[17], aspect) / 0.75);

// Thumb tip to index tip, relative to the palm so it works near or far from the camera
const pinchRatio = (lm: Landmark[], aspect: number) => handDist(lm[4], lm[8], aspect) / palmSize(lm, aspect);

// Each finger (index, middle, ring, little) as clearly up, clearly down, or in between
type FingerState = 'up' | 'down' | 'unsure';
const fingerStates = (lm: Landmark[], aspect: number): FingerState[] =>
    [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => {
        const reach = handDist(lm[tip], lm[0], aspect) / Math.max(1e-6, handDist(lm[pip], lm[0], aspect));
        return reach > 1.15 ? 'up' : reach < 1 ? 'down' : 'unsure';
    });

// Horns: index and little finger clearly up, middle and ring clearly curled (thumb doesn't matter)
const isHorns = (lm: Landmark[], aspect: number) => {
    const [index, middle, ring, little] = fingerStates(lm, aspect);
    return index === 'up' && little === 'up' && middle === 'down' && ring === 'down';
};

// The arpeggio hand is the one further left on screen, or higher up when the halves are stacked
const assignRoles = (all: Landmark[][], portrait: boolean): Hand[] => {
    // Mirrored on screen, so a larger camera x is further left; camera y is screen y
    const arpness = (lm: Landmark[]) => (portrait ? 1 - lm[0].y : lm[0].x);
    const sorted = [...all].sort((a, b) => arpness(b) - arpness(a));
    if (sorted.length === 1) return [{ landmarks: sorted[0], role: arpness(sorted[0]) > 0.5 ? 'arp' : 'synth' }];
    return sorted.slice(0, 2).map((landmarks, i) => ({ landmarks, role: i === 0 ? 'arp' : 'synth' }));
};

export type RecordPhase = 'idle' | 'countdown' | 'recording';
interface RecordState { phase: RecordPhase; since: number } // since: Date.now() when the phase began

export interface HandMusicEvents {
    // phase changes, with Date.now() when the phase began (for the countdown and the running time)
    onRecordState: (phase: RecordPhase, since: number) => void;
    onRecorded: (wav: Blob) => void;
    // LOAD in the picker. Browsers only open a file picker from a real click, so `byClick` says whether it can.
    onRequestFile: (side: Side, byClick: boolean) => void;
    onNotice: (message: string) => void;
}

export const useHandMusic = (
    videoRef: RefObject<HTMLVideoElement | null>,
    canvasRef: RefObject<HTMLCanvasElement | null>,
    setLoading: (loading: boolean) => void,
    setError: (error: string | null) => void,
    events: HandMusicEvents,
) => {
    const audioContextRef = useRef<AudioContext | null>(null);
    const settingsRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
    const voicesRef = useRef<Record<string, Voice>>({});
    const heldArpRef = useRef<Map<string, number>>(new Map());
    const arpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const arpStepRef = useRef(0);
    const loopsRef = useRef<Record<Side, Loop>>({ synth: emptyLoop(), arp: emptyLoop() });
    const lastSynthRecordRef = useRef<Record<string, number>>({});
    const flashesRef = useRef<Record<string, { row: number; col: number; side: Side; time: number }>>({});
    const fistsRef = useRef<Partial<Record<Side, FistTrack>>>({});
    const pausedRef = useRef(false);
    const pinchingRef = useRef(false);
    const hoverRef = useRef<number>(-1); // control band under the cursor
    const grabRef = useRef<number | null>(null); // control band held by the current pinch
    const pinchOnSinceRef = useRef<number | null>(null);
    const pinchOffSinceRef = useRef<number | null>(null);
    const lastCursorRef = useRef<{ point: Point; time: number } | null>(null);
    const masterRef = useRef<GainNode | null>(null);
    const samplesRef = useRef<Samples>({ builtIn: null, mine: {} });
    const recorderRef = useRef<WavRecorder | null>(null);
    const pinchRatioRef = useRef<number | null>(null);
    const eventsRef = useRef(events);
    eventsRef.current = events;
    const recordRef = useRef<RecordState>({ phase: 'idle', since: 0 });
    const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // `label` is fixed when the shape is first made, so it doesn't flip (REC to STOP) once it fires
    // `label` is fixed when the horns are first made (REC or STOP), so it doesn't flip once it fires
    const hornsRef = useRef({ since: null as number | null, lastSeen: 0, fired: false, absentSince: null as number | null, at: null as Point | null, label: 'REC' });
    // The sound picker, open for one side (from MORE in that side's SAMP controls)
    const pickerRef = useRef<Side | null>(null);
    const menuPinchRef = useRef<Record<Side, boolean>>({ arp: false, synth: false });
    // After the picker opens or closes, a pinch only counts once the fingers have parted first, so the
    // pinch that opened it (or picked from it) isn't read again as a new press
    const releaseFirstRef = useRef(false);
    const sampleNamesRef = useRef<Partial<Record<Side, string>>>({});
    const pickedRef = useRef<Partial<Record<Side, number>>>({}); // library index loaded on each side
    const libraryCacheRef = useRef<Record<number, AudioBuffer>>({});
    const mousePointRef = useRef<Point | null>(null);
    const lastLayoutRef = useRef<Layout | null>(null);
    const debugRef = useRef(false);
    const halftoneRef = useRef<ReturnType<typeof createHalftone> | null>(null);
    const smootherRef = useRef(createHandSmoother());
    // Mouse and touch: a side opened by clicking its slots, and the row being pressed or hovered there
    const mouseSideRef = useRef<Side | null>(null);
    const mouseGrabRef = useRef<number | null>(null);
    const mouseHoverRef = useRef(-1);
    const sheetSideRef = useRef<Side | null>(null); // the side whose controls are showing
    const onResultsCallbackRef = useRef<((results: Results) => void) | null>(null);

    // `col` is a camera (unmirrored) column: column 0 is the right edge of the screen
    const midiFor = (row: number, col: number) => noteMidi(row, col, settingsRef.current.key, settingsRef.current.scale);
    const noteFor = (row: number, col: number) => midiToFreq(midiFor(row, col));

    // --- Sound ---

    // The sample a side should play, or null for its oscillator
    const sampleFor = (side: Side): AudioBuffer | null => {
        const sound = side === 'synth' ? settingsRef.current.synthSound : settingsRef.current.arpSound;
        if (sound === 'osc') return null;
        if (sound === 'mine') return samplesRef.current.mine[side] ?? null;
        return samplesRef.current.builtIn?.[sound] ?? null;
    };

    const retireVoice = (key: string) => {
        const ac = audioContextRef.current;
        const voice = voicesRef.current[key];
        if (!ac || !voice) return;
        clearTimeout(voice.timeout);
        voice.gain.gain.setTargetAtTime(0, ac.currentTime, 0.02);
        voice.src.stop(ac.currentTime + 0.15);
        delete voicesRef.current[key];
    };

    const playSynth = (key: string, baseFreq: number) => {
        const ac = audioContextRef.current;
        const master = masterRef.current;
        if (!ac || !master) return;
        const s = settingsRef.current;
        const freq = baseFreq * 2 ** s.octave;
        const buffer = sampleFor('synth');

        // A different sound, or a sample that has already been let go, needs a fresh voice
        const existing = voicesRef.current[key];
        if (existing && (existing.buffer !== buffer || (buffer && existing.released))) retireVoice(key);

        let voice = voicesRef.current[key];
        if (!voice) {
            const gain = ac.createGain();
            let src: OscillatorNode | AudioBufferSourceNode;
            if (buffer) {
                const sample = ac.createBufferSource();
                sample.buffer = buffer;
                sample.playbackRate.setValueAtTime(freq / SAMPLE_BASE_FREQ, ac.currentTime);
                gain.gain.setValueAtTime(0.3 * s.synthVolume, ac.currentTime);
                src = sample;
            } else {
                const osc = ac.createOscillator();
                osc.type = s.waveform;
                osc.frequency.setValueAtTime(freq, ac.currentTime);
                gain.gain.setValueAtTime(0.024 * s.synthVolume, ac.currentTime);
                src = osc;
            }
            src.connect(gain).connect(master);
            src.start();
            voice = voicesRef.current[key] = { src, gain, buffer, released: false };
        } else {
            voice.released = false;
            if (voice.src instanceof OscillatorNode) {
                if (voice.src.type !== s.waveform) voice.src.type = s.waveform;
                voice.src.frequency.setTargetAtTime(freq, ac.currentTime, 0.01);
                voice.gain.gain.setTargetAtTime(0.05 * s.synthVolume, ac.currentTime, 0.05);
            } else {
                voice.src.playbackRate.setTargetAtTime(freq / SAMPLE_BASE_FREQ, ac.currentTime, 0.01);
                voice.gain.gain.setTargetAtTime(0.3 * s.synthVolume, ac.currentTime, 0.05);
            }
        }
        clearTimeout(voice.timeout);
        const held = voice;
        voice.timeout = setTimeout(() => {
            held.released = true;
            held.gain.gain.setTargetAtTime(0, ac.currentTime, s.sustain);
        }, s.sustain * 1000);
    };

    const releaseVoices = (prefix: string, timeConstant: number) => {
        const ac = audioContextRef.current;
        if (!ac) return;
        Object.entries(voicesRef.current).forEach(([key, voice]: [string, Voice]) => {
            if (!key.startsWith(prefix)) return;
            clearTimeout(voice.timeout);
            voice.released = true;
            voice.gain.gain.setTargetAtTime(0, ac.currentTime, timeConstant);
        });
    };

    const playArpNote = (freq: number) => {
        const ac = audioContextRef.current;
        const master = masterRef.current;
        if (!ac || !master) return;
        const s = settingsRef.current;
        const t = ac.currentTime;
        const end = t + s.noteLength;
        const buffer = sampleFor('arp');
        let src: OscillatorNode | AudioBufferSourceNode;
        if (buffer) {
            const sample = ac.createBufferSource();
            sample.buffer = buffer;
            sample.playbackRate.setValueAtTime(freq / SAMPLE_BASE_FREQ, t);
            src = sample;
        } else {
            const osc = ac.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, t);
            src = osc;
        }
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.3 * s.arpVolume, t);
        // Short fade at the end so notes don't click
        gain.gain.setValueAtTime(0.3 * s.arpVolume, end - 0.02);
        gain.gain.linearRampToValueAtTime(0, end);
        src.connect(gain).connect(master);
        src.start(t);
        src.stop(end);
    };

    const arpTick = () => {
        const held = [...heldArpRef.current.entries()].sort((a, b) => a[1] - b[1]);
        if (held.length === 0) {
            arpTimerRef.current = null;
            arpStepRef.current = 0;
            return;
        }
        const n = held.length;
        const step = arpStepRef.current++;
        let i: number;
        switch (settingsRef.current.pattern) {
            case 'down': i = n - 1 - (step % n); break;
            case 'updown': {
                const cycle = Math.max(1, 2 * n - 2);
                const p = step % cycle;
                i = p < n ? p : cycle - p;
                break;
            }
            case 'random': i = Math.floor(Math.random() * n); break;
            default: i = step % n;
        }
        const [cellId, freq] = held[i];
        playArpNote(freq);
        const [row, col] = cellId.split('-').map(Number);
        record('arp', row, col);
        arpTimerRef.current = setTimeout(arpTick, 30000 / settingsRef.current.bpm);
    };

    // --- Loops ---

    const record = (side: Side, row: number, col: number) => {
        const loop = loopsRef.current[side];
        const now = performance.now();
        // An armed loop starts recording on its side's first note, so the loop begins right on it
        if (loop.state === 'armed') {
            loop.state = 'recording';
            loop.start = now;
            loop.events = [];
        }
        if (loop.state === 'recording') loop.events.push({ t: now - loop.start, row, col });
    };

    const toggleLoop = (side: Side) => {
        const loop = loopsRef.current[side];
        if (loop.state === 'empty') {
            loop.state = 'armed';
            return;
        }
        if (side === 'synth' && loop.state === 'playing') releaseVoices('loop:', 0.1);
        loopsRef.current[side] = emptyLoop();
    };

    // Closing a fist ends any recording at the moment the fist started closing
    const finishRecordings = (stopAt: number, now: number) => {
        SIDES.forEach(side => {
            const loop = loopsRef.current[side];
            if (loop.state !== 'recording') return;
            const length = stopAt - loop.start;
            const events = loop.events.filter(e => e.t < length);
            loopsRef.current[side] = events.length > 0 && length >= MIN_LOOP_MS
                // Carry on from where recording stopped, so the rhythm doesn't skip
                ? { state: 'playing', events, start: stopAt, length, lastPos: (now - stopAt) % length }
                : emptyLoop();
        });
    };

    const tickLoops = () => {
        const now = performance.now();
        SIDES.forEach(side => {
            const loop = loopsRef.current[side];
            if (loop.state !== 'playing') return;
            const pos = (now - loop.start) % loop.length;
            const fire = (from: number, to: number) => loop.events.forEach(e => {
                if (e.t < from || e.t >= to) return;
                if (side === 'synth') playSynth(`loop:${e.row}-${e.col}`, noteFor(e.row, e.col));
                else playArpNote(noteFor(e.row, e.col));
                flashesRef.current[`${side}:${e.row}-${e.col}`] = { row: e.row, col: e.col, side, time: now };
            });
            if (pos >= loop.lastPos) fire(loop.lastPos, pos);
            else {
                fire(loop.lastPos, loop.length);
                fire(0, pos);
            }
            loop.lastPos = pos;
        });
    };

    // --- Gestures ---

    // `lm` is null when the hand isn't in view this frame
    const updateFist = (role: Side, lm: Landmark[] | null, aspect: number, now: number) => {
        const f = (fistsRef.current[role] ??= { rawSince: null, releaseSince: null, confirmed: false, closedAt: 0 });
        const curled = lm ? curledFingers(lm, aspect) : 0;

        if (!f.confirmed) {
            // Only one hand can hold the controls open, so a pinching hand can never become a second fist
            const otherHolding = Object.keys(fistsRef.current).some(other => other !== role && fistsRef.current[other].confirmed);
            if (curled === 4 && !otherHolding) {
                f.rawSince ??= now;
                if (now - f.rawSince >= FIST_HOLD_MS) {
                    f.confirmed = true;
                    f.closedAt = f.rawSince;
                    f.releaseSince = null;
                }
            } else {
                f.rawSince = null;
            }
            return;
        }

        // A loosened fist (two or more fingers still curled) keeps the controls open
        if (curled >= 2 || grabRef.current !== null) {
            f.releaseSince = null;
            return;
        }
        f.releaseSince ??= now;
        if (now - f.releaseSince >= (lm ? OPEN_HOLD_MS : LOST_HOLD_MS)) {
            f.confirmed = false;
            f.rawSince = null;
        }
    };

    // A pinch acts on the row under it: pressing picks an option, presses LOOP, or sets a slider, and
    // sliding while pinched keeps adjusting that row. Leaving an option row ends that pinch; a slider stays
    // held until the pinch is released.
    // `closed` is whether the fingers are actually together this frame (not just within the release delay).
    const updateSheet = (side: Side, cursor: Point | null, pinching: boolean, closed: boolean, layout: Layout) => {
        const controls = CONTROLS[side];
        const started = pinching && !pinchingRef.current;
        pinchingRef.current = pinching;
        const hover = cursor ? controls.findIndex((_, i) => contains(layout.bandRect(side, i), cursor)) : -1;
        hoverRef.current = hover;

        if (!pinching || !cursor) {
            grabRef.current = null;
            return;
        }
        if (started) {
            grabRef.current = hover === -1 ? null : hover;
        } else if (grabRef.current !== null && hover !== grabRef.current && controls[grabRef.current].kind !== 'range') {
            // Moved off an option row: done with it until the next pinch. A slider stays held, like a mouse
            // drag, so it can be pulled past its ends and back without letting go.
            grabRef.current = null;
        }
        if (grabRef.current === null) return;
        if (started || closed) applyToRow(side, grabRef.current, cursor, started, layout);
    };

    // A press (or a drag, when `pressed` is false) at point `p` on one control band: picks the option
    // under it, sets a slider, or, on a press, toggles LOOP
    const applyToRow = (side: Side, index: number, p: Point, pressed: boolean, layout: Layout) => {
        const control = CONTROLS[side][index];
        const band = layout.bandRect(side, index);
        if (pressed && control.kind === 'loop') toggleLoop(side);
        if (control.kind === 'choice') {
            const fraction = layout.along(band, p, false);
            const index = Math.max(0, Math.min(control.names.length - 1, Math.floor(fraction * control.names.length)));
            control.setIndex(settingsRef.current, index);
            // Pressing MORE in a SAMP row opens the sound picker for that side
            if (pressed && control.names[index] === SAMPLE_OPTION) openPicker(side);
        }
        if (control.kind === 'range') setFraction(control, settingsRef.current, layout.along(band, p, true));
    };

    // --- Drawing ---

    const drawGrid = (ctx: CanvasRenderingContext2D, layout: Layout, lit: { row: number; col: number; side: Side }[], now: number) => {
        const { grid, cell, line, tile } = layout;
        const sideOf = (col: number): Side => (col < GRID_COLUMNS / 2 ? 'synth' : 'arp');
        const shade = (row: number, col: number, rgb: string, alpha: number) => {
            const c = layout.noteRect(row, col);
            const r = tile(c.x, c.y, c.w, c.h);
            ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
            ctx.fillRect(r.x, r.y, r.w, r.h);
        };

        lit.forEach(({ row, col, side }) => shade(row, col, PALETTE[side].fillRgb, 0.8));
        // Cells played back by a loop, a little lighter
        Object.values(flashesRef.current).forEach(({ row, col, side, time }) => {
            if (now - time <= FLASH_MS) shade(row, col, PALETTE[side].fillRgb, 0.5);
        });

        // Background-coloured lines on every cell edge, the outer edges and the centre included
        ctx.fillStyle = BG;
        for (let c = 0; c <= layout.cols; c++) ctx.fillRect(grid.x + c * cell - line / 2, grid.y - line / 2, line, grid.h + line);
        for (let r = 0; r <= layout.rows; r++) ctx.fillRect(grid.x - line / 2, grid.y + r * cell - line / 2, grid.w + line, line);

        // Note names as small white tags tucked into each cell's bottom-left corner
        for (let row = 0; row < GRID_ROWS; row++) {
            for (let col = 0; col < GRID_COLUMNS; col++) {
                const c = layout.noteRect(row, col);
                drawTag(ctx, layout, midiToName(midiFor(row, col)), c.x + line / 2, c.y + c.h - line / 2,
                    'left', 'bottom', BG, NOTE_INK, NOTE_TAG_SIZE);
            }
        }
    };

    const loopProgress = (loop: Loop, now: number) => ((now - loop.start) % loop.length) / loop.length;

    // Side slots: name over value, with the level rising from the bottom
    const drawStatus = (ctx: CanvasRenderingContext2D, side: Side, layout: Layout, active: boolean, now: number) => {
        const s = settingsRef.current;
        const p = PALETTE[side];
        const blink = Math.floor(now / 300) % 2 === 0;
        const size = Math.round(layout.cell * 0.3);
        ctx.font = `${size}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        CONTROLS[side].forEach((control, i) => {
            const r = layout.slotRect(side, i);
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            let surface = SURFACE;
            let ink = active ? p.inkStrong : p.ink;
            let value = formatControl(control, s);
            let fraction = controlFraction(control, s);
            // On MORE, the SAMP slot names the picked sound (shortened to fit) once there is one
            const picked = sampleNamesRef.current[side];
            if (value === SAMPLE_OPTION && picked) value = picked.replace(' ', '').slice(0, 6);

            if (control.kind === 'loop') {
                const loop = loopsRef.current[side];
                value = { empty: 'OFF', armed: blink ? 'ARM' : '', recording: 'REC', playing: 'PLAY' }[loop.state];
                if (loop.state === 'recording') {
                    surface = blink ? REC : SURFACE;
                    ink = INK_NEUTRAL;
                }
                if (loop.state === 'playing') fraction = loopProgress(loop, now);
            }

            ctx.fillStyle = surface;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            const fill = fraction !== null ? { x: r.x, y: r.y + r.h * (1 - fraction), w: r.w, h: r.h * fraction } : null;
            if (fill) {
                ctx.fillStyle = p.fill;
                ctx.fillRect(fill.x, fill.y, fill.w, fill.h);
            }
            // Two tight lines, about three quarters of the font size apart
            ctx.fillStyle = ink;
            ctx.fillText(control.label, cx, cy - size * 0.38);
            ctx.fillText(value, cx, cy + size * 0.38);
            if (value === SAMPLE_OPTION) underline(ctx, value, cx, cy + size * 0.38, size);
        });
    };

    // While a side's controls are open: one full-width row per control, on the same grid rows as its slots.
    // Sliders fill from the left; options are segments with the current one filled.
    // (In portrait each control is a column instead: options stack top to bottom, sliders fill upward.)
    // `focus` is the row being worked or hovered and the pointer there. Only what's under the
    // pointer lights up: the option itself on an option row, just the text on a slider or LOOP.
    const drawSheet = (ctx: CanvasRenderingContext2D, side: Side, layout: Layout, now: number, focus: { row: number; point: Point } | null) => {
        const s = settingsRef.current;
        const p = PALETTE[side];
        const blink = Math.floor(now / 300) % 2 === 0;
        ctx.font = `${Math.round(layout.cell * 0.32)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        CONTROLS[side].forEach((control, i) => {
            const r = layout.bandRect(side, i);
            const midY = r.y + r.h / 2;
            const focused = focus?.row === i;
            const ink = focused ? p.inkStrong : p.ink;

            if (control.kind === 'choice') {
                ctx.fillStyle = BG;
                ctx.fillRect(r.x, r.y, r.w, r.h);
                const n = control.names.length;
                const current = control.getIndex(s);
                // Sharps sit high and naturals low, like a keyboard (in landscape, where options sit side by side)
                const keyboard = !layout.portrait && control.names.some(name => name.includes('#'));
                control.names.forEach((name, k) => {
                    const seg = layout.segmentRect(r, k, n);
                    const on = k === current;
                    const under = focused && contains({ x: seg.x, y: seg.y, w: seg.w + layout.line, h: seg.h + layout.line }, focus!.point);
                    ctx.fillStyle = on ? p.fill : under ? SURFACE_HOVER : SURFACE;
                    ctx.fillRect(seg.x, seg.y, seg.w, seg.h);
                    ctx.fillStyle = on ? p.inkStrong : ink;
                    const y = keyboard ? seg.y + seg.h * (name.includes('#') ? 0.27 : 0.73) : seg.y + seg.h / 2;
                    ctx.fillText(name, seg.x + seg.w / 2, y);
                    if (name === SAMPLE_OPTION) underline(ctx, name, seg.x + seg.w / 2, y, Math.round(layout.cell * 0.32));
                });
                return;
            }

            ctx.fillStyle = SURFACE;
            ctx.fillRect(r.x, r.y, r.w, r.h);

            let value = formatControl(control, s);
            let fraction = controlFraction(control, s);
            if (control.kind === 'loop') {
                const loop = loopsRef.current[side];
                value = { empty: 'OFF', armed: blink ? 'ARMED' : '', recording: 'REC', playing: 'PLAYING' }[loop.state];
                if (loop.state === 'playing') fraction = loopProgress(loop, now);
            }
            if (fraction !== null) {
                ctx.fillStyle = p.fill;
                if (layout.portrait) ctx.fillRect(r.x, r.y + r.h * (1 - fraction), r.w, r.h * fraction);
                else ctx.fillRect(r.x, r.y, r.w * fraction, r.h);
            }
            ctx.fillStyle = ink;
            if (layout.portrait) {
                // A narrow column: name over value, like the slots
                const size = Math.round(layout.cell * 0.32);
                ctx.fillText(control.label, r.x + r.w / 2, midY - size * 0.38);
                ctx.fillText(value, r.x + r.w / 2, midY + size * 0.38);
            } else {
                ctx.fillText(`${control.label} / ${value}`, r.x + r.w / 2, midY);
            }
        });
    };

    // A red disc, as wide as the open pinch square, that fills in like a pie as `progress` goes 0 to 1,
    // with `label` stretched inside: red over the unfilled part, white over the filled part
    const drawDisc = (ctx: CanvasRenderingContext2D, c: Point, radius: number, progress: number, label: string, weight: number) => {
        ctx.save();
        ctx.strokeStyle = TRACK;
        ctx.fillStyle = TRACK;
        ctx.lineWidth = weight;
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
        const pie = new Path2D();
        pie.moveTo(c.x, c.y);
        pie.arc(c.x, c.y, radius, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI);
        pie.closePath();
        ctx.fill(pie);
        const inner = radius * Math.SQRT1_2; // the square that fits inside the circle
        const box = { x: c.x - inner, y: c.y - inner, w: inner * 2, h: inner * 2 };
        stretchText(ctx, label, box, inner * 0.18);
        ctx.clip(pie);
        ctx.fillStyle = '#ffffff';
        stretchText(ctx, label, box, inner * 0.18);
        ctx.restore();
    };

    // Small flat labels: plain text names the halves, black-on-white marks the axes, white-on-black and red are clickable.
    // (x, y) is the corner given by `align` and `anchor`.
    const drawTag = (ctx: CanvasRenderingContext2D, layout: Layout, text: string, x: number, y: number,
        align: 'left' | 'right', anchor: 'top' | 'bottom', bg: string | null, fg: string, height = TAG_SIZE): Rect => {
        const size = Math.round(layout.cell * height);
        const pad = Math.max(2, Math.round(layout.cell * 0.035));
        ctx.font = `${size}px ${FONT}`;
        const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
        const h = size;
        const r = { x: Math.round(align === 'left' ? x : x - w), y: Math.round(anchor === 'top' ? y : y - h), w, h };
        if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.fillStyle = fg;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, r.x + pad, r.y + h / 2 + 1);
        return r;
    };

    // The halves' names as plain text, so they don't read as buttons: both above the grid in
    // landscape; in portrait, ARPEGGIOS above everything and SYNTHS below
    const drawMarkers = (ctx: CanvasRenderingContext2D, layout: Layout) => {
        const { grid, line } = layout;
        drawTag(ctx, layout, 'ARPEGGIOS', grid.x + line / 2, layout.top - line / 2, 'left', 'bottom', null, HALF_LABEL);
        if (layout.portrait) drawTag(ctx, layout, 'CHORDS', grid.x + line / 2, layout.bottom + line / 2, 'left', 'top', null, HALF_LABEL);
        else drawTag(ctx, layout, 'CHORDS', grid.x + grid.w - line / 2, layout.top - line / 2, 'right', 'bottom', null, HALF_LABEL);
    };

    // The 5-4-3-2-1 countdown as a big stretched digit in the middle of the grid
    const drawCountdown = (ctx: CanvasRenderingContext2D, layout: Layout) => {
        const { grid, cell } = layout;
        const rec = recordRef.current;
        const elapsed = Date.now() - rec.since;
        if (rec.phase === 'countdown') {
            const digit = String(Math.max(1, Math.ceil((COUNTDOWN_MS - elapsed) / 1000)));
            const w = cell * 0.8;
            const h = cell * 1.7;
            ctx.fillStyle = TRACK;
            stretchText(ctx, digit, { x: grid.x + grid.w / 2 - w / 2, y: grid.y + grid.h / 2 - h / 2, w, h }, 0);
        }
    };

    // The picker covers the grid with a board of 30 tiles: 6 x 5 in landscape, 3 x 10 in portrait
    const pickerRect = (layout: Layout, k: number): Rect => {
        const { grid, cell } = layout;
        const columns = layout.portrait ? 3 : 6;
        const rows = 30 / columns;
        const gap = Math.round(cell * 0.14);
        const w = (grid.w - gap) / columns;
        const h = (grid.h - gap) / rows;
        const c = k % columns;
        const r = Math.floor(k / columns);
        const x = Math.round(grid.x + gap + c * w);
        const y = Math.round(grid.y + gap + r * h);
        return { x, y, w: Math.round(grid.x + gap + (c + 1) * w) - gap - x, h: Math.round(grid.y + gap + (r + 1) * h) - gap - y };
    };
    // Tiles 0-28 are library sounds; the last tile is LOAD
    const LOAD_TILE = SAMPLE_LIBRARY.length;
    const pickerTileAt = (layout: Layout, p: Point) => {
        for (let k = 0; k <= LOAD_TILE; k++) if (contains(pickerRect(layout, k), p)) return k;
        return -1;
    };

    const openPicker = (side: Side) => {
        pickerRef.current = side;
        mouseSideRef.current = null;
        // Hands count as still pinching until they let go
        menuPinchRef.current = { arp: true, synth: true };
    };

    const closePicker = () => {
        pickerRef.current = null;
        releaseFirstRef.current = true;
    };

    // Loads library sound `index` as that side's sample sound and switches the side to it
    const pickSample = (side: Side, index: number) => {
        const ac = audioContextRef.current;
        if (!ac) return;
        const sound = SAMPLE_LIBRARY[index];
        samplesRef.current.mine[side] = libraryCacheRef.current[index] ??= sound.render(ac);
        pickedRef.current[side] = index;
        sampleNamesRef.current[side] = sound.name;
        if (side === 'synth') settingsRef.current.synthSound = 'mine';
        else settingsRef.current.arpSound = 'mine';
    };

    // A pinch or click at `p` while the picker is open. Off the picker (outside the grid it covers)
    // closes it; the thin gaps between tiles do nothing.
    const pressPicker = (p: Point, layout: Layout, byClick: boolean) => {
        const side = pickerRef.current;
        if (!side) return;
        const index = pickerTileAt(layout, p);
        if (index === LOAD_TILE) {
            eventsRef.current.onRequestFile(side, byClick);
        } else if (index !== -1) {
            pickSample(side, index);
            closePicker();
        } else if (!contains(layout.grid, p)) {
            closePicker();
        }
    };

    const drawPicker = (ctx: CanvasRenderingContext2D, layout: Layout, side: Side, pointers: Point[]) => {
        const { grid, cell } = layout;
        ctx.fillStyle = PICKER_FRAME;
        ctx.fillRect(grid.x, grid.y, grid.w, grid.h);
        const name = Math.round(cell * 0.32);
        const kind = Math.round(cell * 0.16);
        SAMPLE_LIBRARY.forEach((sound, k) => {
            const r = pickerRect(layout, k);
            const picked = pickedRef.current[side] === k;
            ctx.fillStyle = picked ? PALETTE[side].fill : pointers.some(p => contains(r, p)) ? SURFACE : BG;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            const pad = Math.round(cell * 0.1);
            ctx.fillStyle = picked ? PALETTE[side].inkStrong : PICKER_FRAME;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            ctx.font = `${name}px ${FONT}`;
            sound.name.split(' ').forEach((word, i) => ctx.fillText(word, r.x + pad, r.y + pad + i * name * 0.8));
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'right';
            ctx.font = `${kind}px ${FONT}`;
            ctx.fillText(sound.kind, r.x + r.w - pad, r.y + r.h - pad * 0.6);
        });
        // LOAD: your own file, stretched white on black
        const load = pickerRect(layout, LOAD_TILE);
        ctx.fillStyle = pointers.some(p => contains(load, p)) ? LOAD_HOVER : '#000000';
        ctx.fillRect(load.x, load.y, load.w, load.h);
        ctx.fillStyle = '#ffffff';
        stretchText(ctx, 'LOAD', load, load.h * 0.1);
        const tagX = layout.portrait ? grid.x + grid.w - layout.line / 2 : grid.x + grid.w / 2 + 2 * layout.cell;
        drawTag(ctx, layout, `${SIDE_NAME[side]} · PICK A SOUND`, tagX, layout.top - layout.line / 2, 'right', 'bottom', TRACK, '#ffffff');
    };

    // Hand tracking in signal red. Bones are solid lines and fingertips outlined squares, all one line
    // weight. `u` is one unit of drawing size, scaled with the grid.
    // `pointOf` places a hand's landmark on screen (pointing hands are drawn with their extra reach)
    const drawHands = (ctx: CanvasRenderingContext2D, hands: Hand[], pointOf: (hand: Hand, p: Landmark) => Point, now: number, cursors: Cursor[], u: number) => {
        const weight = Math.max(1, Math.round(1.6 * u));
        const box = (x: number, y: number, half: number) => {
            ctx.lineWidth = weight;
            ctx.strokeRect(Math.round(x - half), Math.round(y - half), Math.round(half * 2), Math.round(half * 2));
        };
        ctx.strokeStyle = TRACK;
        ctx.fillStyle = TRACK;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';

        hands.forEach(hand => {
            const { landmarks, role } = hand;
            const points = landmarks.map(p => pointOf(hand, p));
            ctx.lineWidth = weight;
            ctx.beginPath();
            HAND_CONNECTIONS.forEach(([a, b]) => {
                ctx.moveTo(points[a].x, points[a].y);
                ctx.lineTo(points[b].x, points[b].y);
            });
            ctx.stroke();
            points.forEach(p => ctx.fillRect(Math.round(p.x - weight), Math.round(p.y - weight), weight * 2, weight * 2));

            // A closing fist: LOCK in a disc that fills as the hold completes, solid while the controls are open
            const fist = fistsRef.current[role];
            if (fist?.confirmed || fist?.rawSince != null) {
                const progress = fist.confirmed ? 1 : Math.min(1, (now - fist.rawSince!) / FIST_HOLD_MS);
                drawDisc(ctx, points[9], u * CURSOR_MAX, progress, 'LOCK', weight);
            } else if (!pausedRef.current) {
                FINGERTIP_INDICES.forEach(idx => box(points[idx].x, points[idx].y, weight * 2.5));
            }
        });

        // Pinch cursors: an outlined square that shrinks as thumb and index close, filled once it's a pinch.
        // PINCH sits stretched inside it all the way down, shrinking with it.
        cursors.forEach(({ point, ratio, pinching }) => {
            const open = Math.max(0, Math.min(1, (ratio - PINCH_ON) / PINCH_ON)); // 1 = fingers apart, 0 = pinched
            const half = u * (pinching ? CURSOR_MIN : CURSOR_MIN + (CURSOR_MAX - CURSOR_MIN) * open);
            if (pinching) {
                ctx.fillRect(Math.round(point.x - half), Math.round(point.y - half), Math.round(half * 2), Math.round(half * 2));
            } else {
                box(point.x, point.y, half);
                stretchText(ctx, 'PINCH', { x: point.x - half, y: point.y - half, w: half * 2, h: half * 2 }, half * 0.18);
            }
        });
    };

    // --- Per frame ---

    const handleResults = (results: Results) => {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        if (!canvas || !video) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        fitCanvas(canvas);
        const W = canvas.width;
        const H = canvas.height;
        if (!W || !H) return;
        // Landmarks are normalised to the camera frame, so distances are measured in its proportions
        const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
        const now = performance.now();
        const layout = getLayout(W, H);
        const { grid } = layout;
        // The camera image covers the grid (cropped at the edges if its shape differs), mirrored
        const scale = Math.max(grid.w / aspect, grid.h);
        const view: Rect = { x: grid.x + (grid.w - scale * aspect) / 2, y: grid.y + (grid.h - scale) / 2, w: scale * aspect, h: scale };
        const toScreen = (p: Landmark): Point => ({ x: view.x + (1 - p.x) * view.w, y: view.y + p.y * view.h });

        // Every tracked point is steadied before anything uses it (see smoothing.ts)
        const hands = assignRoles(results.multiHandLandmarks || [], layout.portrait)
            .map(h => ({ ...h, landmarks: smootherRef.current(h.role, h.landmarks, now) }));
        // The pinch point of a hand for controls and the picker, with extra reach toward the grid's edges
        // A point on a hand that's pointing at controls or the picker, pushed out from the grid's centre.
        // The pointing hand is drawn this way too, so its outline and its PINCH square stay together.
        const reached = (lm: Landmark): Point => {
            const p = toScreen(lm);
            const cx = grid.x + grid.w / 2;
            const cy = grid.y + grid.h / 2;
            return { x: cx + (p.x - cx) * REACH_GAIN, y: cy + (p.y - cy) * REACH_GAIN };
        };
        const reach = (lm: Landmark[]): Point => {
            const p = reached({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2, z: 0 });
            return { x: Math.max(grid.x, Math.min(grid.x + grid.w - 1, p.x)), y: Math.max(grid.y, Math.min(grid.y + grid.h - 1, p.y)) };
        };

        // Horns on either hand starts recording (with the countdown) or stops it; not while a fist has the
        // controls open or the picker is up
        const horns = hornsRef.current;
        const fistHolding = SIDES.some(role => fistsRef.current[role]?.confirmed);
        const hornsHand = fistHolding || pickerRef.current ? undefined : hands.find(h => isHorns(h.landmarks, aspect));
        horns.at = hornsHand ? toScreen(hornsHand.landmarks[9]) : null;
        if (hornsHand) {
            horns.lastSeen = now;
            horns.absentSince = null;
            if (horns.since === null) {
                horns.since = now;
                horns.label = recordRef.current.phase === 'idle' ? 'REC' : 'STOP';
            }
            if (!horns.fired && now - horns.since >= GESTURE_HOLD_MS) {
                horns.fired = true;
                toggleRecording().catch(err => console.error('Recording failed:', err));
            }
        } else if (now - horns.lastSeen > GESTURE_GAP_MS) {
            horns.since = null;
            if (horns.fired) {
                horns.absentSince ??= now;
                if (now - horns.absentSince >= GESTURE_RELEASE_MS) horns.fired = false;
            }
        }
        const menuOpen = pickerRef.current !== null;

        // Fists (ignored while the picker is open, so a curled pinch there can't lock)
        if (menuOpen) fistsRef.current = {};
        else SIDES.forEach(role => updateFist(role, hands.find(h => h.role === role)?.landmarks ?? null, aspect, now));

        const fistRoles = SIDES.filter(role => fistsRef.current[role]?.confirmed);
        const paused = fistRoles.length > 0 || menuOpen;
        if (paused && !pausedRef.current) {
            finishRecordings(Math.min(...fistRoles.map(role => fistsRef.current[role]!.closedAt)), now);
            releaseVoices('live:', 0.05);
        }
        if (!paused) {
            pinchingRef.current = false;
            pinchOnSinceRef.current = null;
            pinchOffSinceRef.current = null;
            lastCursorRef.current = null;
            grabRef.current = null;
            hoverRef.current = -1;
        }
        pausedRef.current = paused;

        // With one fist closed, the other hand works the controls for its own side
        const controlSide: Side | null = fistRoles.length === 1 ? (fistRoles[0] === 'synth' ? 'arp' : 'synth') : null;
        let cursor: Point | null = null;
        const cursors: Cursor[] = [];

        // In the picker, every hand gets its own pinch cursor and either can press
        if (menuOpen) {
            hands.forEach(({ landmarks: lm, role }) => {
                const ratio = pinchRatio(lm, aspect);
                const was = menuPinchRef.current[role];
                const pinching = was ? ratio < PINCH_OFF : ratio < PINCH_ON;
                menuPinchRef.current[role] = pinching;
                const point = reach(lm);
                cursors.push({ point, ratio, pinching });
                if (pinching && !was) pressPicker(point, layout, false);
            });
        } else {
            menuPinchRef.current = { arp: false, synth: false };
        }
        if (controlSide) {
            const pointerHand = hands.find(h => h.role !== fistRoles[0]);
            let pinching = pinchingRef.current;
            let closed = false;
            if (pointerHand) {
                const lm = pointerHand.landmarks;
                const ratio = pinchRatio(lm, aspect);
                pinchRatioRef.current = ratio;
                cursor = reach(lm);
                lastCursorRef.current = { point: cursor, time: now };
                closed = ratio < PINCH_OFF;
                // Just back from the picker: wait for the fingers to part before a new pinch counts
                if (releaseFirstRef.current && ratio > PINCH_OFF) releaseFirstRef.current = false;
                if (!pinching) {
                    if (ratio < PINCH_ON && !releaseFirstRef.current) {
                        pinchOnSinceRef.current ??= now;
                        if (now - pinchOnSinceRef.current >= PINCH_PRESS_MS) pinching = true;
                    } else {
                        pinchOnSinceRef.current = null;
                    }
                } else if (ratio > PINCH_OFF) {
                    pinchOffSinceRef.current ??= now;
                    if (now - pinchOffSinceRef.current >= PINCH_RELEASE_MS) pinching = false;
                } else {
                    pinchOffSinceRef.current = null;
                }
                if (!pinching) pinchOffSinceRef.current = null;
                if (pinching) pinchOnSinceRef.current = null;
            } else if (lastCursorRef.current && now - lastCursorRef.current.time < POINTER_LOST_MS) {
                pinchRatioRef.current = null;
                // Hold the last position through a brief dropout
                cursor = lastCursorRef.current.point;
            } else {
                pinching = false;
            }
            updateSheet(controlSide, cursor, pinching, closed, layout);
            if (cursor) cursors.push({ point: cursor, ratio: pinchRatioRef.current ?? PINCH_OFF * 2, pinching });
        }

        // Playing (not while holding the horns, so making it doesn't sound notes)
        const lit: { row: number; col: number; side: Side }[] = [];
        const held = new Map<string, number>();
        if (!paused && !hornsHand) {
            hands.forEach(({ landmarks, role }) => {
                const isSynthHand = role === 'synth';
                FINGERTIP_INDICES.forEach(idx => {
                    const at = layout.noteAt(toScreen(landmarks[idx]));
                    if (!at) return;
                    const { row, col } = at;
                    const isSynthSide = col < GRID_COLUMNS / 2;
                    // Each hand only plays its own side
                    if (isSynthHand !== isSynthSide) return;

                    const freq = noteFor(row, col);
                    const cellId = `${row}-${col}`;
                    if (isSynthSide) {
                        lit.push({ row, col, side: 'synth' });
                        playSynth(`live:${cellId}`, freq);
                        if (now - (lastSynthRecordRef.current[cellId] ?? 0) >= SYNTH_RECORD_THROTTLE_MS) {
                            lastSynthRecordRef.current[cellId] = now;
                            record('synth', row, col);
                        }
                    } else {
                        lit.push({ row, col, side: 'arp' });
                        held.set(cellId, freq);
                    }
                });
            });
        }
        heldArpRef.current = held;
        if (held.size > 0 && !arpTimerRef.current) arpTick();

        // Draw: the camera shows through the grid, mirrored and cropped to fill it
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
        if (HALFTONE) {
            halftoneRef.current ??= createHalftone();
            halftoneRef.current(ctx, video, view, grid, 1, HALFTONE_INK, HALFTONE_INK);
        } else if (video.readyState >= 2) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(grid.x, grid.y, grid.w, grid.h);
            ctx.clip();
            ctx.translate(view.x + view.w, view.y);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0, view.w, view.h);
            ctx.restore();
        }

        drawGrid(ctx, layout, lit, now);
        if (paused) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.fillRect(grid.x, grid.y, grid.w, grid.h);
        }
        // Axis and side labels sit under the controls, so an open panel covers them
        drawMarkers(ctx, layout);
        // A fist's controls take over; otherwise show whichever side was opened by mouse or touch
        const sheetSide = controlSide ?? mouseSideRef.current;
        sheetSideRef.current = sheetSide;
        SIDES.forEach(side => drawStatus(ctx, side, layout, sheetSide === side, now));
        if (sheetSide) {
            const row = controlSide ? (grabRef.current ?? hoverRef.current) : (mouseGrabRef.current ?? mouseHoverRef.current);
            const point = controlSide ? cursor : mousePointRef.current;
            const focus = row === -1 || !point ? null : { row, point };
            drawSheet(ctx, sheetSide, layout, now, focus);
        }
        // The picker sits over everything but the hands, which stay on top to point with
        const pointers = [...cursors.map(c => c.point), ...(mousePointRef.current ? [mousePointRef.current] : [])];
        if (pickerRef.current) drawPicker(ctx, layout, pickerRef.current, pointers);
        drawCountdown(ctx, layout);
        lastLayoutRef.current = layout;
        const u = layout.cell / 90;
        // In the picker every hand points; with the controls open, the hand that isn't the fist does
        const pointing = (hand: Hand) => pickerRef.current !== null || (controlSide !== null && hand.role !== fistRoles[0]);
        drawHands(ctx, hands, (hand, p) => (pointing(hand) ? reached(p) : toScreen(p)), now, cursors, u);
        // Holding the horns: a REC (or STOP) disc that fills until it toggles recording
        if (horns.at && horns.since !== null) {
            const progress = horns.fired ? 1 : Math.min(1, (now - horns.since) / GESTURE_HOLD_MS);
            drawDisc(ctx, horns.at, u * CURSOR_MAX, progress, horns.label, Math.max(1, Math.round(1.6 * u)));
        }
        if (debugRef.current) drawDebug(ctx, hands, aspect, layout);
    };

    // Press D to show what the tracker sees, for tuning the gesture thresholds
    const drawDebug = (ctx: CanvasRenderingContext2D, hands: Hand[], aspect: number, layout: Layout) => {
        const lines = hands.map(({ landmarks, role }) => {
            const fist = fistsRef.current[role];
            return `${role.toUpperCase().padEnd(5)} curled ${curledFingers(landmarks, aspect)}/4  pinch ${pinchRatio(landmarks, aspect).toFixed(2)}  ${fist?.confirmed ? 'FIST' : fist?.rawSince != null ? 'closing' : 'open'}`;
        });
        lines.push(`pinching ${pinchingRef.current}  on<${PINCH_ON} off>${PINCH_OFF}  row ${hoverRef.current}  grab ${grabRef.current}`);
        ctx.font = `${Math.round(layout.cell * 0.24)}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const lineH = layout.cell * 0.26;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(layout.grid.x, layout.grid.y, layout.grid.w / 2, lineH * lines.length + 12);
        ctx.fillStyle = INK_NEUTRAL;
        lines.forEach((line, i) => ctx.fillText(line, layout.grid.x + 8, layout.grid.y + 6 + i * lineH));
    };

    useEffect(() => {
        onResultsCallbackRef.current = handleResults;
    });

    useEffect(() => {
        const videoElement = videoRef.current;
        const canvasElement = canvasRef.current;
        if (!videoElement || !canvasElement) return;

        const ac: AudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = ac;
        // Everything plays through one master gain, which the WAV recorder listens to
        const master = ac.createGain();
        master.connect(ac.destination);
        masterRef.current = master;
        samplesRef.current.builtIn = makeBuiltInSamples(ac);
        recorderRef.current = null;
        createWavRecorder(ac, master)
            .then(recorder => { if (audioContextRef.current === ac) recorderRef.current = recorder; })
            // A context that was closed while the recorder loaded (e.g. React remounting) fails harmlessly
            .catch(err => { if (ac.state !== 'closed') console.error('WAV recording is unavailable:', err); });
        // Mouse and touch: click a side's slots to open its controls, then click or drag on a row
        const toCanvas = (e: PointerEvent): Point => {
            const r = canvasElement.getBoundingClientRect();
            return { x: ((e.clientX - r.left) * canvasElement.width) / r.width, y: ((e.clientY - r.top) * canvasElement.height) / r.height };
        };
        const slotAt = (p: Point, layout: Layout): Side | null =>
            SIDES.find(side => CONTROLS[side].some((_, i) => contains(layout.slotRect(side, i), p))) ?? null;
        const rowAt = (side: Side | null, p: Point, layout: Layout) =>
            side ? CONTROLS[side].findIndex((_, i) => contains(layout.bandRect(side, i), p)) : -1;

        const onPointerDown = (e: PointerEvent) => {
            const layout = getLayout(canvasElement.width, canvasElement.height);
            const p = toCanvas(e);
            // With the picker open, clicks go to it
            if (pickerRef.current) {
                pressPicker(p, layout, true);
                return;
            }
            const slotSide = slotAt(p, layout);
            if (slotSide) {
                mouseSideRef.current = sheetSideRef.current === slotSide ? null : slotSide;
                return;
            }
            const side = sheetSideRef.current;
            const row = rowAt(side, p, layout);
            if (!side || row === -1) {
                mouseSideRef.current = null;
                return;
            }
            mouseGrabRef.current = row;
            canvasElement.setPointerCapture(e.pointerId);
            applyToRow(side, row, p, true, layout);
        };
        const onPointerMove = (e: PointerEvent) => {
            const layout = getLayout(canvasElement.width, canvasElement.height);
            const p = toCanvas(e);
            const side = sheetSideRef.current;
            mouseHoverRef.current = rowAt(side, p, layout);
            mousePointRef.current = p;
            canvasElement.style.cursor = pickerRef.current || slotAt(p, layout) || mouseHoverRef.current !== -1 ? 'pointer' : 'default';
            // A held slider follows the pointer even if it drifts off the row
            if (side && mouseGrabRef.current !== null) applyToRow(side, mouseGrabRef.current, p, false, layout);
        };
        const onPointerUp = () => {
            mouseGrabRef.current = null;
        };
        canvasElement.addEventListener('pointerdown', onPointerDown);
        canvasElement.addEventListener('pointermove', onPointerMove);
        canvasElement.addEventListener('pointerup', onPointerUp);
        canvasElement.addEventListener('pointercancel', onPointerUp);
        const onPointerLeave = () => {
            mousePointRef.current = null;
        };
        canvasElement.addEventListener('pointerleave', onPointerLeave);

        const resumeAudio = () => audioContextRef.current?.resume();
        window.addEventListener('pointerdown', resumeAudio);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'd' || e.key === 'D') debugRef.current = !debugRef.current;
        };
        window.addEventListener('keydown', onKey);
        const loopTimer = setInterval(tickLoops, 15);

        // MediaPipe waits on this callback for every camera frame, so an error escaping it would freeze tracking for good
        const onResults = (results: Results) => {
            try {
                onResultsCallbackRef.current?.(results);
            } catch (err) {
                console.error('Error handling hand-tracking frame:', err);
            }
        };

        if (import.meta.env.DEV) {
            // Lets synthetic hand data be fed in for testing without a camera
            (window as any).__handSynth = {
                feed: onResults, settings: settingsRef.current, loops: loopsRef.current, audio: audioContextRef.current, master: masterRef.current,
                state: () => ({ picker: pickerRef.current }),
            };
        }

        const hands = new Hands({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
        // The fuller model (1) is steadier and copes better with hands partly out of frame than the lite one (0)
        hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
        hands.onResults(onResults);

        let camera: any = null;

        navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
            .then((stream) => {
                videoElement.srcObject = stream;
                videoElement.onloadedmetadata = () => {
                    camera = new Camera(videoElement, {
                        onFrame: async () => await hands.send({ image: videoElement }),
                        width: videoElement.videoWidth,
                        height: videoElement.videoHeight
                    });
                    camera.start();
                    setError(null);
                    setLoading(false);
                };
            })
            .catch((err) => {
                console.error('Error accessing webcam:', err);
                setError('Could not access the webcam. Please check permissions and refresh.');
                setLoading(false);
            });

        return () => {
            camera?.stop();
            (videoElement.srcObject as MediaStream)?.getTracks().forEach(track => track.stop());
            window.removeEventListener('pointerdown', resumeAudio);
            canvasElement.removeEventListener('pointerdown', onPointerDown);
            canvasElement.removeEventListener('pointermove', onPointerMove);
            canvasElement.removeEventListener('pointerup', onPointerUp);
            canvasElement.removeEventListener('pointercancel', onPointerUp);
            canvasElement.removeEventListener('pointerleave', onPointerLeave);
            window.removeEventListener('keydown', onKey);
            clearInterval(loopTimer);
            if (arpTimerRef.current) clearTimeout(arpTimerRef.current);
            arpTimerRef.current = null;
            if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
            Object.values(voicesRef.current).forEach((voice: Voice) => clearTimeout(voice.timeout));
            voicesRef.current = {};
            audioContextRef.current?.close();
            hands.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoRef, canvasRef, setLoading, setError]);

    // Decodes an audio file and makes it that side's SAM sound, named after the file
    const loadSample = async (side: Side, file: File) => {
        const ac = audioContextRef.current;
        if (!ac) throw new Error('Audio is not ready yet');
        samplesRef.current.mine[side] = await ac.decodeAudioData(await file.arrayBuffer());
        delete pickedRef.current[side];
        sampleNamesRef.current[side] = file.name.replace(/\.[^.]+$/, '').toUpperCase();
        if (pickerRef.current === side) closePicker();
        if (side === 'synth') settingsRef.current.synthSound = 'mine';
        else settingsRef.current.arpSound = 'mine';
    };

    // Idle: count down 5 seconds (closing any open controls), then record. During the countdown: cancel.
    // Recording: stop and hand the WAV over to be downloaded.
    const toggleRecording = async () => {
        const setPhase = (phase: RecordPhase) => {
            recordRef.current = { phase, since: Date.now() };
            eventsRef.current.onRecordState(phase, recordRef.current.since);
        };
        const recorder = recorderRef.current;
        if (!recorder) {
            eventsRef.current.onNotice('Recording is not available in this browser');
            return;
        }
        const { phase } = recordRef.current;
        if (phase === 'idle') {
            await audioContextRef.current?.resume();
            mouseSideRef.current = null;
            pickerRef.current = null;
            setPhase('countdown');
            countdownTimerRef.current = setTimeout(() => {
                recorder.start();
                setPhase('recording');
            }, COUNTDOWN_MS);
        } else if (phase === 'countdown') {
            if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
            setPhase('idle');
        } else {
            setPhase('idle');
            eventsRef.current.onRecorded(await recorder.stop());
        }
    };

    // Where the grid is on the page, in CSS pixels, plus one cell's size and the right edge of the slots
    const getGridRect = () => {
        const layout = lastLayoutRef.current;
        const canvas = canvasRef.current;
        if (!layout || !canvas || !canvas.width) return null;
        const box = canvas.getBoundingClientRect();
        const k = box.width / canvas.width;
        const { grid, cell } = layout;
        return {
            x: box.left + grid.x * k, y: box.top + grid.y * k, w: grid.w * k, h: grid.h * k, cell: cell * k,
            // Right edge of everything beside the grid (the synth slots in landscape)
            right: box.left + (grid.x + grid.w + (layout.portrait ? 0 : cell)) * k,
            portrait: layout.portrait,
        };
    };

    return { loadSample, toggleRecording, getGridRect };
};
