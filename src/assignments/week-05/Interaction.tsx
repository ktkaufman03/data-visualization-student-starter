import { useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { csvParse } from 'd3-dsv';
import { useDimensions } from '../../helpers/useDimensions';

interface BreakdownEntry {
    stateProvince: string;
    species: string;
    count: number;
}

interface Summary {
    rows: number;
    columns: number;
    states: string[];
    species: string[];
    breakdown: BreakdownEntry[];
}

// Several fields of the data are ignored because
// we just don't need them.
interface CottontailRow {
    occurrenceID: string;
    species: string;
    stateProvince: string;
    occurrenceStatus: string;
    decimalLatitude: number;
    decimalLongitude: number;
    elevation: number;
    day: number;
    month: number;
    year: number;
}

const DATA_URL = `${import.meta.env.BASE_URL}/data/inaturalist-ne-cottontails/0000410-260903112359142.csv`;

const MARGIN = { top: 16, right: 16, bottom: 40, left: 56 };
const MAX_BAR_WIDTH = 48;

// A bar with only its top (data end) corners rounded.
function barPath(x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.min(radius, width / 2, height);
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export function Interaction() {
    const { ref: divRef, dimensions } = useDimensions();
    const [data, setData] = useState<CottontailRow[] | null>(null);
    const [hovered, setHovered] = useState<BreakdownEntry | null>(null);

    useEffect(() => {
        let cancelled = false;

        fetch(DATA_URL)
            .then((response) => response.text())
            .then((text) => {
                if (cancelled) return;
                const parsed = csvParse(text);
                const converted: CottontailRow[] = parsed.map((row) => ({
                    occurrenceID: row.occurrenceID,
                    species: row.species || "Unknown",
                    stateProvince: row.stateProvince || "Unknown",
                    occurrenceStatus: row.occurrenceStatus,
                    decimalLatitude: +row.decimalLatitude,
                    decimalLongitude: +row.decimalLongitude,
                    elevation: +row.elevation,
                    day: +row.day,
                    month: +row.month,
                    year: +row.year
                }));
                setData(converted);
            })
            .catch((error) => {
                console.error('Failed to load data', error);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const summary = useMemo<Summary | null>(() => {
        if (!data) return null;

        // Rows missing a state or species don't tell us much, so leave them out.
        const known = data.filter((d) => d.stateProvince !== "Unknown" && d.species !== "Unknown");

        const counts = d3.rollup(known, (v) => v.length, (d) => d.stateProvince, (d) => d.species);
        const stateTotals = d3.rollup(known, (v) => v.length, (d) => d.stateProvince);

        // States go from most to least observations; species alphabetically.
        const states = Array.from(stateTotals.keys())
            .sort((a, b) => d3.descending(stateTotals.get(a)!, stateTotals.get(b)!));
        const species = Array.from(new Set(known.map((d) => d.species)))
            .sort(d3.ascending);

        const breakdown: BreakdownEntry[] = [];
        for (let stateProvince of states) {
            for (let [sp, count] of counts.get(stateProvince)!) {
                breakdown.push({ stateProvince, species: sp, count });
            }
        }

        return {
            rows: known.length,
            columns: Object.keys(data[0]).length,
            states,
            species,
            breakdown
        };
    }, [data]);

    // Categorical slots, assigned to species in a fixed order.
    const colors = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
    const colorFor = (species: string) => colors[summary?.species.indexOf(species) ?? -1] || '#898781';

    const innerWidth = Math.max(0, dimensions.width - MARGIN.left - MARGIN.right);
    const innerHeight = Math.max(0, dimensions.height - MARGIN.top - MARGIN.bottom);

    const scales = useMemo(() => {
        const x = d3.scaleBand()
            .domain(summary?.states || [])
            .range([0, innerWidth])
            .paddingInner(0.2)
            .paddingOuter(0.1);

        // Cap the bar width so the marks stay thin on wide screens.
        const groupWidth = Math.min(x.bandwidth(), MAX_BAR_WIDTH * (summary?.species.length || 1));
        const xSpecies = d3.scaleBand()
            .domain(summary?.species || [])
            .range([(x.bandwidth() - groupWidth) / 2, (x.bandwidth() + groupWidth) / 2])
            .paddingInner(0.08);

        // Log scale so the small counts (2-6) are visible next to the large ones (4,000+).
        // Every count is at least 1, so bars start at y = 1.
        const y = d3.scaleLog()
            .domain([1, d3.max(summary?.breakdown || [], (d) => d.count) || 10])
            .nice()
            .range([innerHeight, 0]);

        return { x, xSpecies, y };
    }, [summary, innerWidth, innerHeight]);

    const { x, xSpecies, y } = scales;

    return (
        <div className="flex flex-col w-full h-full gap-2 p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>Rows: {summary?.rows || 0}</span>
                {summary?.species.map((sp) => (
                    <span key={sp} className="flex items-center gap-1">
                        <span className="inline-block w-3 h-3 rounded-sm" style={{ background: colorFor(sp) }} />
                        <i>{sp}</i>
                    </span>
                ))}
            </div>

            <div ref={divRef} className="relative flex-1 min-h-0">
                <svg
                    className="absolute inset-0 w-full h-full"
                    role="img"
                    aria-label="Cottontail observations by state and species"
                >
                    <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
                        {y.ticks().filter((t) => Number.isInteger(Math.log10(t))).map((t) => (
                            <g key={t} transform={`translate(0, ${y(t)})`}>
                                <line x2={innerWidth} stroke="#e1e0d9" />
                                <text x={-8} dy="0.32em" textAnchor="end" fontSize={12} fill="#898781">
                                    {d3.format(",")(t)}
                                </text>
                            </g>
                        ))}

                        {summary?.breakdown.map((d) => {
                            const bx = x(d.stateProvince)! + xSpecies(d.species)!;
                            const by = y(d.count);
                            const isHovered = hovered === d;
                            return (
                                <g
                                    key={`${d.stateProvince}-${d.species}`}
                                    onMouseEnter={() => setHovered(d)}
                                    onMouseLeave={() => setHovered(null)}
                                >
                                    {/* Full-height hit target so tiny bars are still hoverable */}
                                    <rect x={bx} y={0} width={xSpecies.bandwidth()} height={innerHeight} fill="transparent" />
                                    <path
                                        d={barPath(bx, by, xSpecies.bandwidth(), innerHeight - by, 4)}
                                        fill={colorFor(d.species)}
                                        opacity={hovered && !isHovered ? 0.5 : 1}
                                    />
                                </g>
                            );
                        })}

                        <line y1={innerHeight} y2={innerHeight} x2={innerWidth} stroke="#c3c2b7" />
                        {summary?.states.map((s) => (
                            <text
                                key={s}
                                x={x(s)! + x.bandwidth() / 2}
                                y={innerHeight + 20}
                                textAnchor="middle"
                                fontSize={12}
                                fill="#52514e"
                            >
                                {s}
                            </text>
                        ))}
                    </g>
                </svg>

                {hovered && (
                    <div
                        className="absolute pointer-events-none rounded bg-white px-2 py-1 text-sm text-black shadow"
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
