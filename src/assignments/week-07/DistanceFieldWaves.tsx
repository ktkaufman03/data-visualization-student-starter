import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as d3 from 'd3';
import splashUrl from './splash.png';
import { createSDFMask, type Channel } from './sdf';
import { buildPalette, clamp, makeEasing, smoothstep, type Easing } from './waves';

// Ported from https://observablehq.com/d/37b5f81cfdc66b3d ("Distance Field Waves").

const DEFAULT_COLORS = ['#3c6086', '#6ccaf9', '#ffffff'];
const CHANNELS: Channel[] = [0, 1, 2, 3];

// The wave profile is drawn at this size and scaled down to fit.
const PROFILE_WIDTH = 978;
const PROFILE_HEIGHT = 100;

interface MaskOptions {
    invert: boolean;
    limit: number;
    channel: Channel;
}

interface Mask {
    width: number;
    height: number;
    // Distance from the shape for each pixel, as 0-255. Also the index into the palette.
    levels: Uint8Array;
    // The same distances as a black image whose alpha is the distance, for the preview.
    preview: ImageData;
}

// Everything the animation loop reads each frame. It lives in a ref so changing a control
// doesn't restart the loop.
interface FrameParams {
    duration: number;
    coastLevel: number;
    stepRange: number;
    easing: Easing;
    palette: Uint32Array;
    mask: Mask | null;
}

function buildMask(source: ImageData, options: MaskOptions): Mask {
    const { width, height } = source;
    const grid = createSDFMask(source, options);
    const preview = new ImageData(width, height);
    const levels = new Uint8Array(grid.length);

    for (let i = 0; i < grid.length; i++) {
        // grid holds squared distances, so this is twice the distance in pixels.
        const a = Math.min(255, Math.round(Math.sqrt(grid[i]) * 2));
        levels[i] = a;
        preview.data[i * 4 + 3] = a;
    }

    return { width, height, levels, preview };
}

function Control({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex items-center gap-3 text-sm">
            <span className="w-36 shrink-0">{label}</span>
            {children}
        </div>
    );
}

interface RangeControlProps {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
}

function RangeControl({ label, min, max, step, value, onChange }: RangeControlProps) {
    return (
        <Control label={label}>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                aria-label={label}
                onChange={(e) => onChange(+e.target.value)}
                className="w-48 accent-black dark:accent-white"
            />
            <span className="w-12 tabular-nums">{value}</span>
        </Control>
    );
}

interface RadioControlProps<T> {
    label: string;
    options: readonly T[];
    value: T;
    format?: (option: T) => string;
    onChange: (value: T) => void;
}

function RadioControl<T extends string | number>({ label, options, value, format = String, onChange }: RadioControlProps<T>) {
    return (
        <Control label={label}>
            <div role="radiogroup" aria-label={label} className="flex gap-3">
                {options.map((option) => (
                    <label key={option} className="flex items-center gap-1 cursor-pointer">
                        <input
                            type="radio"
                            checked={option === value}
                            onChange={() => onChange(option)}
                            className="accent-black dark:accent-white"
                        />
                        {format(option)}
                    </label>
                ))}
            </div>
        </Control>
    );
}

export function DistanceFieldWaves() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const pathRef = useRef<SVGPathElement>(null);

    const [colors, setColors] = useState(DEFAULT_COLORS);
    // The colors actually in use. They trail `colors` a little so dragging in a color picker
    // doesn't rebuild the palette on every step.
    const [appliedColors, setAppliedColors] = useState(DEFAULT_COLORS);
    const [duration, setDuration] = useState(3000);
    const [coastLevel, setCoastLevel] = useState(0.05);
    const [stepRange, setStepRange] = useState(0.5);
    const [frequency, setFrequency] = useState(16);
    const [direction, setDirection] = useState(-1);
    const [maskOptions, setMaskOptions] = useState<MaskOptions>({ invert: true, limit: 127, channel: 0 });
    const [source, setSource] = useState<ImageData | null>(null);

    useEffect(() => {
        const timeout = setTimeout(() => setAppliedColors(colors), 250);
        return () => clearTimeout(timeout);
    }, [colors]);

    // Read the image's pixels once it loads.
    useEffect(() => {
        let cancelled = false;
        const img = new Image();
        img.src = splashUrl;
        img.decode()
            .then(() => {
                if (cancelled) return;
                const ctx = document.createElement('canvas').getContext('2d')!;
                ctx.canvas.width = img.naturalWidth;
                ctx.canvas.height = img.naturalHeight;
                ctx.drawImage(img, 0, 0);
                setSource(ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight));
            })
            .catch((error) => {
                console.error('Failed to load image', error);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const color = useMemo(() => d3.interpolateRgbBasis(appliedColors), [appliedColors]);
    const palette = useMemo(() => buildPalette(color), [color]);
    const easing = useMemo(() => makeEasing(frequency, direction), [frequency, direction]);
    const mask = useMemo(() => (source ? buildMask(source, maskOptions) : null), [source, maskOptions]);

    // Bottom to top, the profile's background runs through the palette like the distance does.
    const profileBackground = useMemo(() => {
        const stops = d3.range(11).map((i) => `${color(i / 10)} ${i * 10}%`);
        return `linear-gradient(0deg, ${stops.join(', ')})`;
    }, [color]);

    const params = useRef<FrameParams>({ duration, coastLevel, stepRange, easing, palette, mask });
    useEffect(() => {
        params.current = { duration, coastLevel, stepRange, easing, palette, mask };
    }, [duration, coastLevel, stepRange, easing, palette, mask]);

    useEffect(() => {
        if (mask) previewRef.current?.getContext('2d')?.putImageData(mask.preview, 0, 0);
    }, [mask]);

    // One animation loop draws both the canvas and the wave profile.
    useEffect(() => {
        const easedPalette = new Uint32Array(256);
        let frameMask: Mask | null = null;
        let imageData: ImageData | null = null;
        let pixels: Uint32Array | null = null;

        // The profile plots the wave height against distance from the shape, with the shape on the left.
        const x = d3.scaleLinear().domain([0, 1]).range([0, PROFILE_WIDTH]);
        const y = d3.scaleLinear().domain([0, 1]).range([PROFILE_HEIGHT, 0]);
        const samples = d3.range(PROFILE_WIDTH).map((i) => i / PROFILE_WIDTH);
        const area = d3.area<number>().x((l) => x(l)).y0(y(0));
        const path = d3.select(pathRef.current);

        let raf = 0;
        const frame = () => {
            const { duration, coastLevel, stepRange, easing, palette, mask } = params.current;
            const t = (Date.now() / duration) % 1,
                min = 0.5 - stepRange,
                max = 0.5 + stepRange;

            path.attr('d', area.y1((l) => y(smoothstep(min, max, easing(l, t))))(samples));

            const ctx = canvasRef.current?.getContext('2d');
            if (mask && ctx) {
                if (mask !== frameMask) {
                    frameMask = mask;
                    imageData = new ImageData(mask.width, mask.height);
                    pixels = new Uint32Array(imageData.data.buffer);
                }

                // Pixels within the coastal offset stay at full level; past it, the waves take over.
                for (let i = 0; i < 256; i++) {
                    const l = i / 255 < coastLevel ? 1 : easing(i / 255 - coastLevel, t);
                    easedPalette[i] = palette[clamp(0, 255, Math.floor(smoothstep(min, max, l) * 255))];
                }
                const { levels } = mask;
                for (let i = 0; i < levels.length; i++) pixels![i] = easedPalette[levels[i]];

                ctx.putImageData(imageData!, 0, 0);
            }

            raf = requestAnimationFrame(frame);
        };
        frame();

        return () => cancelAnimationFrame(raf);
    }, []);

    return (
        <div className="flex flex-col w-full h-full gap-4 p-4 overflow-y-auto">
            <h1 className="text-xl font-semibold">Distance Field Waves</h1>

            <canvas
                ref={canvasRef}
                width={mask?.width ?? 0}
                height={mask?.height ?? 0}
                role="img"
                aria-label="Waves rippling outward from an ink splash"
                className="max-w-full h-auto self-start"
            />

            <svg
                width={PROFILE_WIDTH}
                height={PROFILE_HEIGHT}
                viewBox={`0 0 ${PROFILE_WIDTH} ${PROFILE_HEIGHT}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label="Wave height by distance from the shape"
                className="max-w-full h-auto self-start shrink-0 border border-gray-400 dark:border-gray-600"
                style={{ background: profileBackground }}
            >
                <path ref={pathRef} stroke={color(0)} strokeWidth={2} fill={color(1)} />
            </svg>

            <div className="flex flex-col gap-2">
                <Control label="Colors">
                    <div className="flex gap-2">
                        {colors.map((c, i) => (
                            <input
                                key={i}
                                type="color"
                                value={c}
                                aria-label={`Color ${i + 1}`}
                                onChange={(e) => setColors(colors.map((old, j) => (j === i ? e.target.value : old)))}
                                className="cursor-pointer"
                            />
                        ))}
                    </div>
                </Control>
                <RangeControl label="Loop duration" min={500} max={5000} step={500} value={duration} onChange={setDuration} />
                <RangeControl label="Coastal offset" min={0} max={0.3} step={0.01} value={coastLevel} onChange={setCoastLevel} />
                <RangeControl label="Smoothness" min={0} max={0.5} step={0.01} value={stepRange} onChange={setStepRange} />
                <RangeControl label="Frequency" min={1} max={30} step={0.1} value={frequency} onChange={setFrequency} />
                <RadioControl
                    label="Primary direction"
                    options={[1, -1]}
                    value={direction}
                    format={(d) => (d > 0 ? 'inwards' : 'outwards')}
                    onChange={setDirection}
                />
            </div>

            <hr className="border-gray-200 dark:border-gray-700" />

            <h2 className="text-lg font-semibold">Mask</h2>
            <img src={splashUrl} alt="Ink splash used as the shape" className="w-[400px] max-w-full" />

            <div className="flex flex-col gap-2">
                <Control label="Invert">
                    <input
                        type="checkbox"
                        checked={maskOptions.invert}
                        aria-label="Invert"
                        onChange={(e) => setMaskOptions({ ...maskOptions, invert: e.target.checked })}
                        className="accent-black dark:accent-white"
                    />
                </Control>
                <Control label="Limit">
                    <input
                        type="number"
                        min={0}
                        max={255}
                        step={1}
                        value={maskOptions.limit}
                        aria-label="Limit"
                        onChange={(e) => {
                            // Ignore a cleared box rather than masking with NaN.
                            if (e.target.value === '') return;
                            setMaskOptions({ ...maskOptions, limit: clamp(0, 255, Math.round(+e.target.value)) });
                        }}
                        className="w-20 border border-gray-300 rounded px-1 dark:border-gray-600"
                    />
                </Control>
                <RadioControl
                    label="Channel"
                    options={CHANNELS}
                    value={maskOptions.channel}
                    onChange={(channel) => setMaskOptions({ ...maskOptions, channel })}
                />
            </div>

            <canvas
                ref={previewRef}
                width={mask?.width ?? 0}
                height={mask?.height ?? 0}
                role="img"
                aria-label="Distance from the shape, darker further away"
                className="w-[400px] max-w-full h-auto self-start"
            />
        </div>
    );
}
