
export const GRID_ROWS = 7;
export const GRID_COLUMNS = 12;
export const FINGERTIP_INDICES = [4, 8, 12, 16, 20];

export const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9],
    [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17],
    [0, 17], [17, 18], [18, 19], [19, 20],
];

// Six notes per row, as semitones above the key's root. Rows are octaves: the bottom row is octave 1.
export const SCALES = {
    maj: [0, 2, 4, 5, 7, 9],
    min: [0, 2, 3, 5, 7, 10],
    pent: [0, 2, 4, 7, 9, 12],
    mpent: [0, 3, 5, 7, 10, 12],
    blues: [0, 3, 5, 6, 7, 10],
    mixo: [0, 2, 5, 7, 9, 10],
} as const;
export type ScaleName = keyof typeof SCALES;

export const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// `col` is a camera (unmirrored) column; each half of the grid repeats the row's six notes
export const noteMidi = (row: number, col: number, key: number, scale: ScaleName) =>
    12 * (GRID_ROWS - row + 1) + key + SCALES[scale][col % 6];

export const midiToFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export const midiToName = (midi: number) => `${NOTE_LETTERS[midi % 12]}${Math.floor(midi / 12) - 1}`;
