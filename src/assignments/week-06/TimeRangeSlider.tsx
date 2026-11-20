import { formatMonth, type MonthRange } from './time';

export interface TimeRangeSliderProps {
    // The earliest and latest month the slider can reach.
    extent: MonthRange;
    range: MonthRange;
    onRangeChange: (range: MonthRange) => void;
}

// A two-thumb slider for picking a range of months, with the selected months on either side.
export function TimeRangeSlider({ extent, range, onRangeChange }: TimeRangeSliderProps) {
    const [min, max] = extent;
    const [lo, hi] = range;
    const pct = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * 100);

    // Two range inputs stacked on one track. The inputs ignore the mouse and only their
    // thumbs catch it, so either thumb can be grabbed.
    const thumb = "pointer-events-none absolute inset-0 m-0 h-full w-full appearance-none bg-transparent " +
        "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 " +
        "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black dark:[&::-webkit-slider-thumb]:bg-white " +
        "[&::-webkit-slider-thumb]:cursor-pointer " +
        "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 " +
        "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black dark:[&::-moz-range-thumb]:bg-white " +
        "[&::-moz-range-thumb]:cursor-pointer";

    return (
        <div className="flex items-center gap-3">
            <span className="w-16 text-right tabular-nums">{formatMonth(lo)}</span>
            <div className="relative h-5 w-64">
                <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-gray-200 dark:bg-gray-700" />
                <div
                    className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-gray-500 dark:bg-gray-400"
                    style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
                />
                <input
                    type="range"
                    min={min}
                    max={max}
                    value={lo}
                    aria-label="Earliest month"
                    aria-valuetext={formatMonth(lo)}
                    onChange={(e) => onRangeChange([Math.min(+e.target.value, hi), hi])}
                    className={thumb}
                    // When the thumbs meet near the right end, the start thumb must be on top
                    // or it could never be dragged back out.
                    style={{ zIndex: lo > (min + max) / 2 ? 2 : 1 }}
                />
                <input
                    type="range"
                    min={min}
                    max={max}
                    value={hi}
                    aria-label="Latest month"
                    aria-valuetext={formatMonth(hi)}
                    onChange={(e) => onRangeChange([lo, Math.max(+e.target.value, lo)])}
                    className={thumb}
                />
            </div>
            <span className="w-16 tabular-nums">{formatMonth(hi)}</span>
        </div>
    );
}
