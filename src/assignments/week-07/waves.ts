import * as d3 from 'd3';

export function clamp(a: number, b: number, v: number) {
    return v < a ? a : v > b ? b : v;
}

export function smoothstep(min: number, max: number, value: number) {
    const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return x * x * (3 - 2 * x);
}

// Wave height at distance `l` (0 at the shape, 1 far away) and loop time `t` (0 to 1).
// Two cosine waves are mixed together and fade out with distance.
export function makeEasing(frequency: number, direction: number) {
    const TAU = Math.PI * 2,
        n = (v: number) => 0.5 + 0.5 * v,
        cos = (v: number) => Math.cos(v * TAU),
        mix = (a: number, b: number, t: number) => a + (b - a) * t;

    return (l: number, t: number) => {
        t *= direction;
        // Partially unrolled pow(n, 3)
        return (1 - l) ** 2 * (1 - l) * (
            (1 - mix(n(cos(l * l * frequency * 2 - t)), n(cos(l * frequency + t)), 0.8)) ** 2
        );
    };
}

export type Easing = ReturnType<typeof makeEasing>;

// 256 colors sampled from `color`, packed as RGBA pixels so they can be written straight into ImageData.
export function buildPalette(color: (t: number) => string) {
    const rgba = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
        const { r, g, b } = d3.rgb(color(i / 255));
        rgba.set([r, g, b, 255], i * 4);
    }
    return new Uint32Array(rgba.buffer);
}
