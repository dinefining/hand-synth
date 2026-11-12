// Built-in instrument samples, rendered in code, and WAV capture of the master output.

export type BuiltInSample = 'pluck' | 'bell' | 'keys';

// Every sample, built-in or loaded, is treated as sounding at A4 and is repitched from there
export const SAMPLE_BASE_FREQ = 440;

const render = (ac: BaseAudioContext, seconds: number, fill: (data: Float32Array, rate: number) => void) => {
    const buffer = ac.createBuffer(1, Math.round(seconds * ac.sampleRate), ac.sampleRate);
    const data = buffer.getChannelData(0);
    fill(data, ac.sampleRate);
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    for (let i = 0; i < data.length; i++) data[i] *= 0.8 / peak;
    return buffer;
};

export const makeBuiltInSamples = (ac: BaseAudioContext): Record<BuiltInSample, AudioBuffer> => ({
    // Karplus-Strong plucked string
    pluck: render(ac, 2, (data, rate) => {
        const period = Math.round(rate / SAMPLE_BASE_FREQ);
        const ring = Float32Array.from({ length: period }, () => Math.random() * 2 - 1);
        for (let i = 0; i < data.length; i++) {
            const k = i % period;
            data[i] = ring[k];
            ring[k] = 0.996 * 0.5 * (ring[k] + ring[(k + 1) % period]);
        }
    }),
    // FM bell: inharmonic modulator with a decaying index
    bell: render(ac, 3, (data, rate) => {
        for (let i = 0; i < data.length; i++) {
            const t = i / rate;
            const index = 4 * Math.exp(-3 * t);
            data[i] = Math.exp(-1.5 * t) * Math.sin(2 * Math.PI * SAMPLE_BASE_FREQ * t + index * Math.sin(2 * Math.PI * SAMPLE_BASE_FREQ * 1.4 * t));
        }
    }),
    // Electric-piano-ish: a few harmonics with a quick attack and decay
    keys: render(ac, 2, (data, rate) => {
        for (let i = 0; i < data.length; i++) {
            const t = i / rate;
            const env = Math.min(1, t / 0.005) * Math.exp(-2.5 * t);
            const w = 2 * Math.PI * SAMPLE_BASE_FREQ * t;
            data[i] = env * (Math.sin(w) + 0.5 * Math.sin(2 * w) * Math.exp(-3 * t) + 0.25 * Math.sin(3 * w) * Math.exp(-5 * t) + 0.12 * Math.sin(4 * w) * Math.exp(-8 * t));
        }
    }),
});

// --- Sound library: 29 instruments for SAM A / SAM B (the picker's 30th tile loads a file), rendered when first picked ---

export interface LibrarySound {
    name: string;
    kind: string;
    render: (ac: BaseAudioContext) => AudioBuffer;
}

const TAU = 2 * Math.PI;
const F = SAMPLE_BASE_FREQ;

// A sound described as a function of time in seconds
const tone = (seconds: number, wave: (t: number) => number) => (ac: BaseAudioContext) =>
    render(ac, seconds, (data, rate) => {
        for (let i = 0; i < data.length; i++) data[i] = wave(i / rate);
    });

// Quick linear attack, then exponential decay with time constant `time`
const env = (t: number, attack: number, time: number) => Math.min(1, t / attack) * Math.exp(-t / time);

// Sine partials: [frequency ratio, level, decay time]
const partials = (list: [number, number, number][], attack = 0.003) => (t: number) =>
    list.reduce((sum, [ratio, level, time]) => sum + level * env(t, attack, time) * Math.sin(TAU * F * ratio * t), 0);

// Band-limited sawtooth from `n` harmonics
const saw = (t: number, f: number, n: number) => {
    let v = 0;
    for (let k = 1; k <= n; k++) v += Math.sin(TAU * f * k * t) / k;
    return v;
};

// Karplus-Strong string: `feedback` sets how long it rings, `soften` smooths the initial pluck
const string = (seconds: number, feedback: number, soften: number) => (ac: BaseAudioContext) =>
    render(ac, seconds, (data, rate) => {
        const period = Math.round(rate / F);
        const ring = Float32Array.from({ length: period }, () => Math.random() * 2 - 1);
        for (let pass = 0; pass < soften; pass++) {
            for (let k = 1; k < period; k++) ring[k] = 0.5 * (ring[k] + ring[k - 1]);
        }
        for (let i = 0; i < data.length; i++) {
            const k = i % period;
            data[i] = ring[k];
            ring[k] = feedback * 0.5 * (ring[k] + ring[(k + 1) % period]);
        }
    });

// "Ah" vowel weights for the choir's harmonics
const vowel = (f: number) =>
    0.15 + Math.exp(-(((f - 800) / 150) ** 2)) + 0.6 * Math.exp(-(((f - 1150) / 150) ** 2)) + 0.25 * Math.exp(-(((f - 2900) / 300) ** 2));
const CHOIR_WEIGHTS = Array.from({ length: 12 }, (_, k) => vowel(F * (k + 1)));

export const SAMPLE_LIBRARY: LibrarySound[] = [
    { name: 'PLUCK', kind: 'STRING', render: string(2, 0.996, 0) },
    { name: 'HARP', kind: 'STRING', render: string(3, 0.998, 2) },
    { name: 'NYLON', kind: 'STRING', render: string(2.5, 0.997, 4) },
    { name: 'BANJO', kind: 'STRING', render: string(0.8, 0.985, 0) },
    {
        name: 'BELL', kind: 'METAL',
        render: tone(3, t => Math.exp(-1.5 * t) * Math.sin(TAU * F * t + 4 * Math.exp(-3 * t) * Math.sin(TAU * F * 1.4 * t))),
    },
    { name: 'GLOCK', kind: 'METAL', render: tone(2, partials([[1, 1, 0.8], [2.76, 0.5, 0.3], [5.4, 0.25, 0.12]])) },
    {
        name: 'CHIME', kind: 'METAL',
        render: tone(3, t => env(t, 0.002, 1.2) * Math.sin(TAU * F * t + 3 * Math.exp(-2 * t) * Math.sin(TAU * F * 3.5 * t))),
    },
    { name: 'GONG', kind: 'METAL', render: tone(4, partials([[1, 1, 2], [1.48, 0.6, 1.6], [2.12, 0.5, 1.2], [2.83, 0.4, 0.9], [3.6, 0.3, 0.6]], 0.02)) },
    { name: 'STEEL', kind: 'METAL', render: tone(1.8, partials([[1, 1, 0.6], [2, 0.6, 0.4], [3, 0.3, 0.25], [4.2, 0.2, 0.15]])) },
    {
        name: 'KEYS', kind: 'PIANO',
        render: tone(2, t => {
            const w = TAU * F * t;
            return env(t, 0.005, 0.4) * (Math.sin(w) + 0.5 * Math.sin(2 * w) * Math.exp(-3 * t) + 0.25 * Math.sin(3 * w) * Math.exp(-5 * t));
        }),
    },
    {
        name: 'ORGAN', kind: 'PIANO',
        render: tone(2, t => Math.min(1, t / 0.01) * [1, 2, 3, 4, 6, 8].reduce((v, r, i) => v + Math.sin(TAU * F * r * t) / (i + 1), 0)),
    },
    { name: 'CLAV', kind: 'PIANO', render: tone(1, t => env(t, 0.001, 0.25) * (0.6 * Math.sign(Math.sin(TAU * F * t)) + 0.4 * saw(t, F, 12))) },
    { name: 'TOY PIANO', kind: 'PIANO', render: tone(1.5, partials([[1, 1, 0.5], [3.01, 0.4, 0.2], [6.2, 0.2, 0.08]])) },
    { name: 'MUSIC BOX', kind: 'PIANO', render: tone(2.5, partials([[1, 1, 1.2], [4, 0.3, 0.3], [8.1, 0.1, 0.1]])) },
    { name: 'MARIMBA', kind: 'WOOD', render: tone(1.2, partials([[1, 1, 0.35], [4, 0.35, 0.08], [10, 0.1, 0.02]])) },
    { name: 'KALIMBA', kind: 'WOOD', render: tone(1.6, partials([[1, 1, 0.6], [5.4, 0.3, 0.1], [2, 0.15, 0.3]])) },
    { name: 'VIBES', kind: 'WOOD', render: tone(2.5, t => (1 + 0.3 * Math.sin(TAU * 5 * t)) * partials([[1, 1, 1.5], [4, 0.2, 0.3]])(t)) },
    { name: 'WOODBLOCK', kind: 'WOOD', render: tone(0.4, partials([[1, 1, 0.06], [2.3, 0.5, 0.03]], 0.0005)) },
    { name: 'SQUARE', kind: 'CHIP', render: tone(1.5, t => env(t, 0.002, 0.8) * Math.sign(Math.sin(TAU * F * t))) },
    { name: 'PULSE', kind: 'CHIP', render: tone(1.5, t => env(t, 0.002, 0.8) * ((F * t) % 1 < 0.25 ? 1 : -0.33)) },
    { name: 'TRIANGLE', kind: 'CHIP', render: tone(1.5, t => env(t, 0.002, 0.8) * (2 * Math.abs(2 * ((F * t) % 1) - 1) - 1)) },
    // Pitch drops from an octave above into the note
    { name: 'BLIP', kind: 'CHIP', render: tone(0.5, t => env(t, 0.001, 0.12) * Math.sign(Math.sin(TAU * F * (t + (1 - Math.exp(-40 * t)) / 40)))) },
    { name: 'SUB', kind: 'BASS', render: tone(2, t => env(t, 0.005, 1.2) * Math.sin(TAU * F * t)) },
    { name: 'FM BASS', kind: 'BASS', render: tone(1.5, t => env(t, 0.002, 0.6) * Math.sin(TAU * F * t + 2.5 * Math.exp(-6 * t) * Math.sin(TAU * F * t))) },
    // Harmonics fade out over the note, like a closing filter
    { name: 'ACID', kind: 'BASS', render: tone(1.2, t => env(t, 0.002, 0.5) * saw(t, F, Math.max(2, Math.round(30 * Math.exp(-5 * t))))) },
    { name: 'PAD', kind: 'PAD', render: tone(3, t => Math.min(1, t / 0.6) * Math.exp(-t / 4) * (saw(t, F * 0.997, 12) + saw(t, F * 1.003, 12))) },
    {
        name: 'STRINGS', kind: 'PAD',
        render: tone(3, t => Math.min(1, t / 0.35) * Math.exp(-t / 3) * (saw(t, F, 16) + saw(t, F * 1.006, 16) + saw(t, F * 0.994, 16))),
    },
    {
        name: 'CHOIR', kind: 'PAD',
        render: tone(3, t => {
            const vibrato = 1 + 0.002 * Math.sin(TAU * 5 * t);
            return Math.min(1, t / 0.4) * Math.exp(-t / 3) * CHOIR_WEIGHTS.reduce((v, w, k) => v + w * Math.sin(TAU * F * (k + 1) * t * vibrato), 0);
        }),
    },
    {
        name: 'FLUTE', kind: 'WIND',
        render: tone(2, t => Math.min(1, t / 0.08) * Math.exp(-t / 2.5)
            * (Math.sin(TAU * F * t * (1 + 0.003 * Math.sin(TAU * 5 * t))) + 0.1 * Math.sin(TAU * 2 * F * t) + 0.05 * (Math.random() * 2 - 1))),
    },
];

// --- WAV capture ---

// Passes audio through untouched and, while recording, sends it to the page in batches
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.recording = false;
        this.batch = [];
        this.frames = 0;
        this.port.onmessage = e => {
            this.recording = e.data.recording;
            if (!this.recording) this.flush();
        };
    }
    flush() {
        if (this.batch.length) this.port.postMessage(this.batch);
        this.batch = [];
        this.frames = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (this.recording && input.length) {
            this.batch.push(input.map(channel => channel.slice(0)));
            this.frames += input[0].length;
            if (this.frames >= 8192) this.flush();
        }
        return true;
    }
}
registerProcessor('hand-synth-tap', Tap);
`;

export interface WavRecorder {
    start: () => void;
    stop: () => Promise<Blob>;
}

export const createWavRecorder = async (ac: AudioContext, source: AudioNode): Promise<WavRecorder> => {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await ac.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const tap = new AudioWorkletNode(ac, 'hand-synth-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    source.connect(tap);
    // The tap writes no output; connecting it just keeps it running
    tap.connect(ac.destination);

    let chunks: Float32Array[][] = [];
    let onFlushed: (() => void) | null = null;
    tap.port.onmessage = (e: MessageEvent<Float32Array[][]>) => {
        chunks.push(...e.data);
        onFlushed?.();
    };

    return {
        start: () => {
            chunks = [];
            tap.port.postMessage({ recording: true });
        },
        stop: () => new Promise<Blob>(resolve => {
            // Give the worklet a moment to send its last batch
            const finish = () => {
                onFlushed = null;
                resolve(encodeWav(chunks, ac.sampleRate));
            };
            const timer = setTimeout(finish, 300);
            onFlushed = () => {
                clearTimeout(timer);
                setTimeout(finish, 50);
            };
            tap.port.postMessage({ recording: false });
        }),
    };
};

// 16-bit PCM WAV
const encodeWav = (chunks: Float32Array[][], sampleRate: number): Blob => {
    const channels = chunks[0]?.length ?? 2;
    const frames = chunks.reduce((n, c) => n + c[0].length, 0);
    const buffer = new ArrayBuffer(44 + frames * channels * 2);
    const view = new DataView(buffer);
    const text = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));

    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * channels * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * channels * 2, true);

    let offset = 44;
    chunks.forEach(chunk => {
        for (let i = 0; i < chunk[0].length; i++) {
            for (let c = 0; c < channels; c++) {
                const v = Math.max(-1, Math.min(1, (chunk[c] ?? chunk[0])[i]));
                view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
                offset += 2;
            }
        }
    });
    return new Blob([buffer], { type: 'audio/wav' });
};
