import { useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import type { CottontailRow } from './types';
import { monthIndex, type MonthRange } from './time';
import type { TimeRangeSliderProps } from './TimeRangeSlider';

// A month-range filter over the observations. Each caller keeps its own range.
// Returns the rows inside the range, and the props for a <TimeRangeSlider> that controls it
// (null until the data has loaded).
export function useTimeFilter(data: CottontailRow[] | null) {
    // null means the full date range; set once the slider is first moved.
    const [range, setRange] = useState<MonthRange | null>(null);
    const [appliedRange, setAppliedRange] = useState<MonthRange | null>(null);

    // The slider spans the earliest to latest month in the whole dataset.
    const extent = useMemo<MonthRange | null>(() => {
        const [min, max] = d3.extent(data ?? [], monthIndex);
        return min === undefined || max === undefined ? null : [min, max];
    }, [data]);

    // Re-clustering 16k points on every slider step would stall the map, so the filter is
    // applied once the slider has been still for a moment.
    useEffect(() => {
        const timeout = setTimeout(() => setAppliedRange(range), 250);
        return () => clearTimeout(timeout);
    }, [range]);

    const filtered = useMemo(() => {
        if (!data || !appliedRange) return data;
        const [lo, hi] = appliedRange;
        return data.filter((d) => monthIndex(d) >= lo && monthIndex(d) <= hi);
    }, [data, appliedRange]);

    const timeSlider: TimeRangeSliderProps | null =
        extent && { extent, range: range ?? extent, onRangeChange: setRange };

    return { filtered, timeSlider };
}
