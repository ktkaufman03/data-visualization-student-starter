// Source: https://observablehq.com/@mourner/fast-distance-transform#edt1d
// Modified to accept v, z and f as arguments, so the buffers are shared across rows and columns.
// Squared 1D distance transform of one row or column of `grid`, done in place.
function edt1d(
    grid: Float64Array,
    offset: number,
    stride: number,
    length: number,
    v: Uint32Array,
    z: Float64Array,
    f: Float64Array,
    INF = 1e16
) {
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride];

    for (let q = 1, k = 0, s = 0; q < length; q++) {
        do {
            const r = v[k];
            s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
        } while (s <= z[k] && --k > -1);

        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }

    for (let q = 0, k = 0; q < length; q++) {
        while (z[k + 1] < q) k++;
        const r = v[k];
        grid[offset + q * stride] = f[r] + (q - r) * (q - r);
    }
}

export type Channel = 0 | 1 | 2 | 3;

export interface SDFMaskOptions {
    // Which RGBA channel decides what counts as inside the shape.
    channel?: Channel;
    invert?: boolean;
    // Channel values at or above this are inside the shape.
    limit?: number;
    INF?: number;
}

// The squared distance from each pixel to the nearest pixel inside the shape (0 inside it).
// Adapted from https://observablehq.com/@mourner/fast-distance-transform
export function createSDFMask(
    imageData: ImageData,
    { channel = 3, invert = false, limit = 127, INF = 1e6 }: SDFMaskOptions = {}
) {
    const { width: w, height: h, data } = imageData;
    const grid = new Float64Array(w * h);
    const inv = invert ? (v: number) => 255 - v : (v: number) => v;
    const lim = (v: number) => (v >= limit ? 255 : 0);

    for (let i = 0; i < grid.length; i++) {
        const a = lim(inv(data[4 * i + channel])) / 255;
        grid[i] = a === 1 ? 0 : a === 0 ? INF : Math.max(0, 0.5 - a) ** 2;
    }

    const max = Math.max(w, h),
        v = new Uint32Array(max),
        z = new Float64Array(max + 1),
        f = new Float64Array(max);

    for (let x = 0; x < w; x++) edt1d(grid, x, w, h, v, z, f);
    for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, v, z, f);

    return grid;
}
