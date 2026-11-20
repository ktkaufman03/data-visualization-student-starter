import { useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useDimensions } from '../../helpers/useDimensions';
import type { CottontailRow } from './types';
import { speciesColor } from './species';
import { TimeRangeSlider } from './TimeRangeSlider';
import { useTimeFilter } from './useTimeFilter';

interface BreakdownEntry {
    stateProvince: string;
    species: string;
    count: number;
}

interface Summary {
    rows: number;
    states: string[];
    species: string[];
    breakdown: BreakdownEntry[];
    // Largest count over the whole dataset, so the y-axis stays put as the time filter changes.
    maxCount: number;
}

// Rows missing a state or species don't tell us much, so leave them out.
const isKnown = (d: CottontailRow) => d.stateProvince !== "Unknown" && d.species !== "Unknown";

const MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };
const MAX_BAR_WIDTH = 48;

// A bar with only its top (data end) corners rounded.
function barPath(x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.min(radius, width / 2, height);
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export function SpeciesBarChart({ data }: { data: CottontailRow[] | null }) {
    // This tab's own time range, independent of the Geography tab.
    const { filtered, timeSlider } = useTimeFilter(data);
    const { ref: divRef, dimensions } = useDimensions();
    const [hovered, setHovered] = useState<BreakdownEntry | null>(null);
    const [hoveredSpecies, setHoveredSpecies] = useState<string | null>(null);
    const [hiddenSpecies, setHiddenSpecies] = useState<Set<string>>(new Set());

    const toggleSpecies = (species: string) => {
        setHiddenSpecies((prev) => {
            const next = new Set(prev);
            if (next.has(species)) next.delete(species);
            else next.add(species);
            return next;
        });
        // A bar that's removed while hovered never gets onMouseLeave, so clear it here
        // or it keeps dimming the other bars and showing its tooltip.
        setHovered((h) => (h?.species === species ? null : h));
    };

    // The states, species and axis come from the whole dataset, so bars don't reorder, change
    // color or rescale while the time filter is dragged.
    const categories = useMemo(() => {
        const known = (data ?? []).filter(isKnown);
        const stateTotals = d3.rollup(known, (v) => v.length, (d) => d.stateProvince);
        const counts = d3.rollup(known, (v) => v.length, (d) => d.stateProvince, (d) => d.species);

        return {
            // States go from most to least observations; species alphabetically.
            states: Array.from(stateTotals.keys())
                .sort((a, b) => d3.descending(stateTotals.get(a)!, stateTotals.get(b)!)),
            species: Array.from(new Set(known.map((d) => d.species))).sort(d3.ascending),
            maxCount: d3.max(counts.values(), (bySpecies) => d3.max(bySpecies.values())) ?? 0
        };
    }, [data]);

    const summary = useMemo<Summary | null>(() => {
        if (!data || !filtered) return null;

        const known = filtered.filter(isKnown);
        const counts = d3.rollup(known, (v) => v.length, (d) => d.stateProvince, (d) => d.species);

        const breakdown: BreakdownEntry[] = [];
        for (const stateProvince of categories.states) {
            for (const [sp, count] of counts.get(stateProvince) ?? []) {
                breakdown.push({ stateProvince, species: sp, count });
            }
        }

        return {
            rows: known.length,
            ...categories,
            breakdown
        };
    }, [data, filtered, categories]);

    const colorFor = (species: string) => speciesColor(species, summary?.species || []);

    const innerWidth = Math.max(0, dimensions.width - MARGIN.left - MARGIN.right);
    const innerHeight = Math.max(0, dimensions.height - MARGIN.top - MARGIN.bottom);

    const scales = useMemo(() => {
        const x = d3.scaleBand()
            .domain(summary?.states || [])
            .range([0, innerWidth])
            .paddingInner(0.2)
            .paddingOuter(0.1);

        // Only visible species get a slot, so the remaining bars close up the gap.
        const visibleSpecies = summary?.species.filter((sp) => !hiddenSpecies.has(sp)) || [];

        // Cap the bar width so the marks stay thin on wide screens.
        const groupWidth = Math.min(x.bandwidth(), MAX_BAR_WIDTH * (visibleSpecies.length || 1));
        const xSpecies = d3.scaleBand()
            .domain(visibleSpecies)
            .range([(x.bandwidth() - groupWidth) / 2, (x.bandwidth() + groupWidth) / 2])
            .paddingInner(0.08);

        // Log scale so the small counts (2-6) are visible next to the large ones (4,000+).
        // Every count is at least 1, so bars start at y = 1.
        const y = d3.scaleLog()
            .domain([1, summary?.maxCount || 10])
            .nice()
            .range([innerHeight, 0]);

        return { x, xSpecies, y };
    }, [summary, hiddenSpecies, innerWidth, innerHeight]);

    const { x, xSpecies, y } = scales;

    // The species being highlighted, from either a hovered bar or a hovered legend entry.
    // Hovering a hidden species' legend entry highlights nothing, since it has no bars.
    const legendSpecies = hoveredSpecies && !hiddenSpecies.has(hoveredSpecies) ? hoveredSpecies : null;
    const activeSpecies = hovered?.species ?? legendSpecies;

    return (
        <div className="flex flex-col w-full h-full gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>Rows: {d3.format(",")(summary?.rows || 0)}</span>                {summary?.species.map((sp) => {
                    const isHidden = hiddenSpecies.has(sp);
                    return (
                        <button
                            key={sp}
                            type="button"
                            aria-pressed={!isHidden}
                            title={isHidden ? "Show species" : "Hide species"}
                            className={`flex items-center gap-1 cursor-pointer ${isHidden ? "line-through text-gray-400 dark:text-gray-500" : ""}`}
                            onClick={() => toggleSpecies(sp)}
                            onMouseEnter={() => setHoveredSpecies(sp)}
                            onMouseLeave={() => setHoveredSpecies(null)}
                            style={{
                                opacity: activeSpecies && activeSpecies !== sp ? 0.25 : 1,
                                transition: "opacity 150ms"
                            }}
                        >
                            <span
                                className="inline-block w-3 h-3 rounded-sm"
                                style={{ background: isHidden ? "var(--color-chart-axis)" : colorFor(sp) }}
                            />
                            <i>{sp}</i>
                        </button>
                    );
                })}
            </div>

            {timeSlider && (
                <div className="text-sm">
                    <TimeRangeSlider {...timeSlider} />
                </div>
            )}

            <div ref={divRef} className="relative flex-1 min-h-0">
                <svg
                    className="absolute inset-0 w-full h-full"
                    role="img"
                    aria-label="Cottontail observations by state and species"
                >
                    <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
                        {y.ticks().filter((t) => Number.isInteger(Math.log10(t))).map((t) => (
                            <g key={t} transform={`translate(0, ${y(t)})`}>
                                <line x2={innerWidth} className="stroke-chart-grid" />
                                <text x={-8} dy="0.32em" textAnchor="end" fontSize={12} className="fill-chart-muted">
                                    {d3.format(",")(t)}
                                </text>
                            </g>
                        ))}

                        {summary?.breakdown.filter((d) => !hiddenSpecies.has(d.species)).map((d) => {
                            const bx = x(d.stateProvince)! + xSpecies(d.species)!;
                            const by = y(d.count);
                            // A hovered bar highlights only itself; a hovered legend entry highlights all of its species' bars.
                            const isDimmed = hovered ? hovered !== d : !!legendSpecies && legendSpecies !== d.species;
                            return (
                                <path
                                    key={`${d.stateProvince}-${d.species}`}
                                    d={barPath(bx, by, xSpecies.bandwidth(), innerHeight - by, 4)}
                                    fill={colorFor(d.species)}
                                    opacity={isDimmed ? 0.25 : 1}
                                    style={{ transition: "opacity 150ms" }}
                                    onMouseEnter={() => setHovered(d)}
                                    onMouseLeave={() => setHovered(null)}
                                />
                            );
                        })}

                        <line y1={innerHeight} y2={innerHeight} x2={innerWidth} className="stroke-chart-axis" />
                        {summary?.states.map((s) => (
                            <text
                                key={s}
                                x={x(s)! + x.bandwidth() / 2}
                                y={innerHeight + 20}
                                textAnchor="middle"
                                fontSize={12}
                                className="fill-chart-label"
                            >
                                {s}
                            </text>
                        ))}
                    </g>
                </svg>

                {hovered && (
                    <div
                        className="absolute pointer-events-none whitespace-nowrap rounded bg-white px-2 py-1 text-sm text-black shadow dark:bg-gray-800 dark:text-gray-100"
                        style={{
                            left: MARGIN.left + x(hovered.stateProvince)! + xSpecies(hovered.species)! + xSpecies.bandwidth() / 2,
                            top: MARGIN.top + y(hovered.count),
                            transform: "translate(-50%, calc(-100% - 8px))"
                        }}
                    >
                        <div>{hovered.stateProvince}</div>
                        <div><i>{hovered.species}</i>: {d3.format(",")(hovered.count)}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
