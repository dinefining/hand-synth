
// These interfaces describe the structure of the data returned by MediaPipe Hands.
export interface Landmark {
    x: number;
    y: number;
    z: number;
    visibility?: number;
}

export interface HandResult {
    label: 'Left' | 'Right';
    score: number;
}

export interface Results {
    multiHandLandmarks: Landmark[][];
    multiHandedness: HandResult[];
}

// The MediaPipe libraries are loaded from a CDN and attach themselves to the window object.
// We declare them here to inform TypeScript about their existence and prevent compilation errors.
// Using `any` is a pragmatic choice here as full type definitions for these CDN-loaded libraries
// are not readily available.
declare global {
    // These are constructors for the MediaPipe classes.
    const Hands: any;
    const Camera: any;
}
