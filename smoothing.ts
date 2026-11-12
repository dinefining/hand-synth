// Steadies hand-tracking points with the One Euro filter (Casiez et al.): heavy smoothing when a point is
// still or moving slowly (no jitter), light smoothing when it moves fast (no lag).

import type { Landmark } from './types';

// Cut-off frequency (Hz) when still, and how much it rises with speed (in frame-widths per second)
const MIN_CUTOFF = 0.5;
const BETA = 8;
const DERIVATIVE_CUTOFF = 1;
// A hand missing this long starts fresh, so it doesn't glide in from where it was last seen
const RESET_AFTER_MS = 300;

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

class OneEuro {
    private value: number | null = null;
    private speed = 0;

    filter(x: number, dt: number) {
        if (this.value === null) {
            this.value = x;
            return x;
        }
        const rawSpeed = (x - this.value) / dt;
        this.speed += alpha(DERIVATIVE_CUTOFF, dt) * (rawSpeed - this.speed);
        this.value += alpha(MIN_CUTOFF + BETA * Math.abs(this.speed), dt) * (x - this.value);
        return this.value;
    }
}

// One set of filters per hand, keyed by its role (which side it plays)
export const createHandSmoother = () => {
    const hands = new Map<string, { filters: OneEuro[]; last: number }>();

    return (key: string, landmarks: Landmark[], now: number): Landmark[] => {
        let hand = hands.get(key);
        if (!hand || now - hand.last > RESET_AFTER_MS) {
            hand = { filters: Array.from({ length: landmarks.length * 3 }, () => new OneEuro()), last: now };
            hands.set(key, hand);
        }
        const dt = Math.max(0.001, (now - hand.last) / 1000);
        hand.last = now;
        const f = hand.filters;
        return landmarks.map((p, i) => ({
            x: f[i * 3].filter(p.x, dt),
            y: f[i * 3 + 1].filter(p.y, dt),
            z: f[i * 3 + 2].filter(p.z, dt),
        }));
    };
};
