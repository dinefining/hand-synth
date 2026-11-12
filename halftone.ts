// Renders the camera as a fine clustered-dot halftone: each half of the grid gets dots in its own
// colour on white. The frame is processed at a reduced size, then drawn back up with hard pixel edges.

interface Rect { x: number; y: number; w: number; h: number }
export type Rgb = [number, number, number];

// 4x4 clustered-dot threshold matrix: dots grow outward from the tile corners, like printed halftone
const DOT = [12, 5, 6, 13, 4, 0, 1, 7, 11, 3, 2, 8, 15, 10, 9, 14].map(v => (v + 0.5) / 16);

// A pixel is inked when its brightness (0-255) is below its cell's threshold. The image is darkened
// and its contrast raised (tone = (lum - 0.5) * CONTRAST + EXPOSURE), folded into the thresholds so
// the loop is one comparison.
const CONTRAST = 1.7;
const EXPOSURE = 0.45;
const LUM_THRESHOLD = DOT.map(t => ((t - EXPOSURE) / CONTRAST + 0.5) * 255);

// RGBA bytes as one little-endian 32-bit pixel
const pack = ([r, g, b]: Rgb) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const WHITE = 0xffffffff;

export const createHalftone = () => {
    const src = document.createElement('canvas');
    const srcCtx = src.getContext('2d', { willReadFrequently: true })!;
    const out = document.createElement('canvas');
    const outCtx = out.getContext('2d')!;
    let outData: ImageData | null = null;

    /**
     * `view` is where the full camera frame sits on the canvas (it may overhang the grid), `pixel` is the
     * size of one halftone pixel in canvas pixels, and the video is mirrored like the rest of the scene.
     */
    return (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, view: Rect, grid: Rect, pixel: number, left: Rgb, right: Rgb) => {
        if (video.readyState < 2) return;
        const w = Math.max(1, Math.round(grid.w / pixel));
        const h = Math.max(1, Math.round(grid.h / pixel));
        if (src.width !== w || src.height !== h || !outData) {
            src.width = out.width = w;
            src.height = out.height = h;
            outData = outCtx.createImageData(w, h);
        }

        srcCtx.setTransform(-1 / pixel, 0, 0, 1 / pixel, (view.x + view.w - grid.x) / pixel, (view.y - grid.y) / pixel);
        srcCtx.drawImage(video, 0, 0, view.w, view.h);
        const px = srcCtx.getImageData(0, 0, w, h).data;
        const o = new Uint32Array(outData.data.buffer);
        const half = w >> 1;
        const leftInk = pack(left);
        const rightInk = pack(right);

        for (let y = 0, i = 0; y < h; y++) {
            const row = (y & 3) * 4;
            for (let x = 0; x < w; x++, i++) {
                const j = i * 4;
                const lum = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
                o[i] = lum < LUM_THRESHOLD[row + (x & 3)] ? (x < half ? leftInk : rightInk) : WHITE;
            }
        }
        outCtx.putImageData(outData, 0, 0);

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(out, grid.x, grid.y, w * pixel, h * pixel);
        ctx.restore();
    };
};
