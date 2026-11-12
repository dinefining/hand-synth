import React, { useEffect, useRef, useState } from 'react';
import { useHandMusic } from './hooks/useHandMusic';
import type { RecordPhase } from './hooks/useHandMusic';
import type { Side } from './controls';

const RED = '#ff3b2f';
const COUNTDOWN_S = 5;

// Local date and time, e.g. 20261010-154210
const timestamp = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const clock = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Draws into a canvas at its displayed size (in device pixels), again whenever that size changes or fonts load
const useCanvasDrawing = (draw: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void, deps: React.DependencyList) => {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const redraw = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx || !canvas.clientWidth || !canvas.clientHeight) return;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(canvas.clientWidth * dpr);
            canvas.height = Math.round(canvas.clientHeight * dpr);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            draw(canvas, ctx);
        };
        const observer = new ResizeObserver(redraw);
        observer.observe(canvas);
        document.fonts.ready.then(redraw);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return ref;
};

// Text stretched on both axes to fill its box with even padding (a fraction of the box), like the canvas labels
const StretchedLabel: React.FC<{ text: string; color?: string; pad?: number }> = ({ text, color = '#000000', pad = 0.16 }) => {
    const ref = useCanvasDrawing((canvas, ctx) => {
        const px = canvas.width * pad;
        const py = canvas.height * pad;
        ctx.font = '100px VT323, monospace';
        const m = ctx.measureText(text);
        const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        ctx.save();
        ctx.translate(px, py);
        ctx.scale((canvas.width - px * 2) / w, (canvas.height - py * 2) / h);
        ctx.fillStyle = color;
        ctx.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
        ctx.restore();
    }, [text, color, pad]);
    return <canvas ref={ref} className="w-full h-full" />;
};

// Inline pictures for the how-to, in the app's look: hand gestures as emoji on square grey tiles,
// and the app's own LOCK / PINCH / RECORDING marks in red. They're sized close to
// the text so they sit inside a line, and centred on it the same way whatever they hold.
const ICON = 'inline-flex items-center justify-center w-[1.2em] h-[1.2em] mx-[0.15em] align-middle relative -top-[0.08em]';
const TILE = '#dcdcdc'; // dark enough to show against the white info overlay

// Emoji fonts pad their glyphs unevenly, so draw the emoji and centre it by its visible shape
const EmojiTile: React.FC<{ emoji: string }> = ({ emoji }) => {
    const ref = useCanvasDrawing((canvas, ctx) => {
        ctx.font = `${Math.round(canvas.height * 0.68)}px system-ui, sans-serif`;
        const m = ctx.measureText(emoji);
        const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
        const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
        ctx.fillText(emoji, (canvas.width - w) / 2 + m.actualBoundingBoxLeft, (canvas.height - h) / 2 + m.actualBoundingBoxAscent);
    }, [emoji]);
    return <canvas ref={ref} className="w-full h-full" />;
};
const Hand: React.FC<{ emoji: string }> = ({ emoji }) => (
    <span className={ICON} style={{ background: TILE }}>
        <EmojiTile emoji={emoji} />
    </span>
);
const Lock = () => (
    <span className={`${ICON} rounded-full`} style={{ background: RED }}>
        <StretchedLabel text="LOCK" color="#ffffff" pad={0.2} />
    </span>
);
const Pinch = () => (
    <>
        <span className={`${ICON} border`} style={{ borderColor: RED }}>
            <StretchedLabel text="PINCH" color={RED} pad={0.1} />
        </span>
        <span className="inline-block w-[0.4em] h-[0.4em] mr-[0.15em] align-middle relative -top-[0.08em]" style={{ background: RED }} />
    </>
);
const RecordingTag = () => (
    <span className="px-[0.2em] mx-[0.15em] text-white" style={{ background: RED }}>RECORDING</span>
);
// A word set as a small tag, in the colours of what it names on screen
const Tag: React.FC<{ bg: string; fg: string; children: React.ReactNode }> = ({ bg, fg, children }) => (
    <span className="px-[0.2em] mx-[0.1em]" style={{ background: bg, color: fg }}>{children}</span>
);
const ARP_TAG = { bg: '#f7dd4a', fg: '#000000' }; // the sides' yellow
const SYNTH_TAG = { bg: '#f7dd4a', fg: '#000000' };
const HEADING = '#9a9a9a';

const App: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const fileSideRef = useRef<Side>('arp');
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showInfo, setShowInfo] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [record, setRecord] = useState<{ phase: RecordPhase; since: number }>({ phase: 'idle', since: 0 });
    const [now, setNow] = useState(Date.now());
    const [, setResized] = useState(0);

    const downloadWav = (wav: Blob) => {
        const url = URL.createObjectURL(wav);
        const link = document.createElement('a');
        link.href = url;
        link.download = `hand-synth-${timestamp()}.wav`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const { loadSample, toggleRecording, getGridRect } = useHandMusic(videoRef, canvasRef, setIsLoading, setError, {
        onRecordState: (phase, since) => setRecord({ phase, since }),
        onRecorded: downloadWav,
        onNotice: setNotice,
        // LOAD in the picker. Only a real click may open the browser's file picker.
        onRequestFile: (side, byClick) => {
            if (!byClick) {
                setNotice('Click LOAD with the mouse to choose a file');
                return;
            }
            setNotice(null);
            fileSideRef.current = side;
            fileRef.current?.click();
        },
    });

    // Tick the countdown and running time by REC
    useEffect(() => {
        if (record.phase === 'idle') return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(timer);
    }, [record]);

    // The info text sits over the grid, so follow the window's size while it's open
    useEffect(() => {
        if (!showInfo) return;
        const onResize = () => setResized(n => n + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [showInfo]);

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            await loadSample(fileSideRef.current, file);
        } catch {
            setNotice(`Couldn't read ${file.name} as audio`);
        }
    };

    const elapsed = now - record.since;
    const recordStatus = record.phase === 'countdown'
        ? String(Math.max(1, Math.ceil(COUNTDOWN_S - elapsed / 1000)))
        : record.phase === 'recording' ? clock(elapsed) : null;

    // Info: text laid over the grid, CLOSE to the right of it. Where there's no room beside the grid (phones),
    // CLOSE sits in the top-right corner on the same margins as INFO and REC, and the text starts below it.
    const MARGIN_TOP = 12; // matches top-3 on INFO / REC
    const MARGIN_SIDE = 16; // matches left-4 / right-4
    const grid = showInfo ? getGridRect() : null;
    const closeSize = grid ? Math.max(56, grid.cell * 1.5) : 64;
    const closeFits = grid && !grid.portrait && grid.right + grid.cell * 0.25 + closeSize <= window.innerWidth - 8;
    const closeStyle: React.CSSProperties = closeFits
        ? { left: grid!.right + grid!.cell * 0.25, top: Math.max(8, grid!.y - grid!.cell * 0.6), width: closeSize, height: closeSize }
        : { right: MARGIN_SIDE, top: MARGIN_TOP, width: closeSize, height: closeSize };
    const belowClose = MARGIN_TOP + closeSize + MARGIN_TOP;
    const textTop = grid ? Math.max(grid.y + grid.cell * 0.15, closeFits ? 0 : belowClose) : belowClose;
    const textStyle: React.CSSProperties = grid
        ? {
            left: grid.x + grid.cell * 0.2, top: textTop, width: grid.w - grid.cell * 0.4,
            maxHeight: grid.y + grid.h - grid.cell * 0.15 - textTop,
            fontSize: Math.max(14, Math.min(30, grid.cell * 0.3)),
        }
        : { left: MARGIN_SIDE, right: MARGIN_SIDE, top: textTop, bottom: MARGIN_SIDE, fontSize: 18 };

    return (
        <div className="relative w-screen h-screen bg-white flex justify-center items-center overflow-hidden font-['VT323',monospace]">
            {/* Loading: just a blinking dot in the sides' yellow */}
            {isLoading && (
                <span aria-label="Loading" className="absolute z-20 w-4 h-4 rounded-full blink" style={{ background: '#f7dd4a' }} />
            )}
            {error && (
                 <div className="absolute z-20 text-[#3a3a3a] text-center bg-[#efefef] p-8">
                    <p className="text-3xl">ERROR</p>
                    <p className="text-xl text-[#8a8a8a] mt-2">{error}</p>
                 </div>
            )}

            <video ref={videoRef} className="absolute top-0 left-0 w-[80vw] h-auto hidden" autoPlay playsInline></video>

            <canvas
                ref={canvasRef}
                className={`absolute inset-0 w-full h-full touch-none transition-opacity duration-500 ${isLoading || error ? 'opacity-0' : 'opacity-100'}`}
            ></canvas>

            <input
                ref={fileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={e => {
                    onFile(e.target.files?.[0]);
                    e.target.value = '';
                }}
            />

            {/* Top bar: INFO on the left, REC on the right (a blinking dot and the countdown or time while recording) */}
            <button
                onClick={() => setShowInfo(v => !v)}
                aria-label={showInfo ? 'Close instructions' : 'How to play'}
                className="absolute top-3 left-4 z-50 text-xl leading-none text-black"
            >
                INFO
            </button>
            <button
                onClick={() => {
                    setNotice(null);
                    toggleRecording();
                }}
                aria-label={record.phase === 'idle' ? 'Record' : record.phase === 'countdown' ? 'Cancel recording' : 'Stop recording'}
                className="absolute top-3 right-4 z-30 flex items-center gap-[0.4em] text-xl leading-none"
                style={{ color: record.phase === 'idle' ? '#000000' : RED }}
            >
                {recordStatus && (
                    <>
                        <span className="inline-block w-[0.65em] h-[0.65em] rounded-full blink" style={{ background: RED }} />
                        <span>{recordStatus}</span>
                    </>
                )}
                <span>REC</span>
            </button>

            {notice && (
                <button
                    onClick={() => setNotice(null)}
                    className="absolute top-12 right-4 z-30 bg-[#efefef] text-[#3a3a3a] text-xl px-3 py-2"
                >
                    {notice}
                </button>
            )}

            {showInfo && (
                <div className="absolute inset-0 z-40 bg-white/85" onClick={() => setShowInfo(false)}>
                    <div
                        className="absolute overflow-y-auto text-black leading-[1.3]"
                        style={textStyle}
                        onClick={e => e.stopPropagation()}
                    >
                        <p className="mb-[0.4em]" style={{ color: HEADING }}>GESTURES</p>
                        <p className="mb-[0.5em]">
                            Make sounds with <Hand emoji="✋🏽" />. Fist up <Hand emoji="✊🏽" /> to <Lock /> that side and open sound
                            controls on the other. Stays open as long as the fist is closed.
                        </p>
                        <p className="mb-[0.5em]">
                            Select controls with pinch <Hand emoji="🤏🏽" /> <Pinch /> or hold and move the sliders.
                        </p>
                        <p className="mb-[1.2em]">
                            Show respect to the metal gods <Hand emoji="🤘🏽" /> to start <RecordingTag />. Do it again to stop: it saves a WAV.
                        </p>
                        <p className="mb-[0.4em]" style={{ color: HEADING }}>NOTES</p>
                        <p className="mb-[0.5em]">
                            {grid?.portrait ? 'Top half plays ' : 'Left side plays '}<Tag {...ARP_TAG}>ARPEGGIOS</Tag>.{' '}
                            {grid?.portrait ? 'Bottom plays ' : 'Right plays '}<Tag {...SYNTH_TAG}>CHORDS</Tag>.
                        </p>
                        <p>
                            Each side is loopable. Pinch <Tag bg={TILE} fg="#000000">LOOP</Tag> to arm it, open your fist and play: it
                            records from your first note on that side. Close a fist to end it and it repeats. Pinch <Tag bg={TILE} fg="#000000">LOOP</Tag> again to clear.
                        </p>
                        <p className="mt-[1.2em]">
                            A{' '}
                            <a href="https://maybemachines.com" target="_blank" rel="noopener noreferrer" className="px-[0.2em] text-white" style={{ background: '#2443ff' }}>
                                Maybe Machine
                            </a>{' '}
                            by{' '}
                            <a href="https://ravipopat.info" target="_blank" rel="noopener noreferrer" className="px-[0.2em] text-white" style={{ background: '#2443ff' }}>
                                Ravi Popat
                            </a>.
                        </p>
                    </div>
                    <button
                        onClick={() => setShowInfo(false)}
                        aria-label="Close"
                        className="absolute bg-white border-2 border-black"
                        style={closeStyle}
                    >
                        <StretchedLabel text="CLOSE" pad={0.12} />
                    </button>
                </div>
            )}
        </div>
    );
};

export default App;
