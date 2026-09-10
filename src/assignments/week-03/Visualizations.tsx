import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { csvParse } from 'd3-dsv';
import { useDimensions } from '../../helpers/useDimensions';

interface Summary {
    rows: number;
    columns: number;
    species_breakdown: { species: string; count: number }[]
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

const FONT_SIZE = 28;
const LINE_HEIGHT = FONT_SIZE * 1.2;

export function Visualizations() {
    const svgRef = useRef<SVGSVGElement>(null);
    const { ref: divRef, dimensions } = useDimensions();
    const [data, setData] = useState<CottontailRow[] | null>(null);

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
                    stateProvince: row.stateProvince,
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

        let species_breakdown: { [key: string]: number } = {};

        for (let entry of data) {
            if (!(entry.species in species_breakdown))
                species_breakdown[entry.species] = 0;
            species_breakdown[entry.species]++;
        }

        return {
            rows: data.length,
            columns: Object.keys(data[0]).length,
            species_breakdown: Object.keys(species_breakdown).map(k => ({
                species: k,
                count: species_breakdown[k]
            }))
        };
    }, [data]);

    const colors = ["#fcba03", "#0398fc", "#fc3103", "#5b00d1"];

    const pieArcs = useMemo(() => {
        const pie = d3.pie<{ species: string; count: number }>().value((d) => d.count)(summary?.species_breakdown || []);

        return pie.map(p => d3.arc()({
            innerRadius: 0,
            outerRadius: 256,
            startAngle: p.startAngle,
            endAngle: p.endAngle
        })!);
    }, [data]);

    return (
        <div ref={divRef} className="relative w-full h-full">
            <svg
                className="absolute inset-0 w-full h-full"
                role="img"
                aria-label="Summary of the NE Cottontail dataset"
            >
                <g transform={`translate(${dimensions.width / 2}, ${dimensions.height / 2})`}>
                    {pieArcs.map((a, i) => <path key={i} d={a} fill={colors[i] || '#000000'} />)}
                </g>
            </svg>

            <p>Rows: {summary?.rows || 0}</p>
            <p>
                Breakdown by Species:
                <ul>
                    {summary?.species_breakdown?.map((sb, i) => <li><span style={{"color": colors[i] || '#000000'}}>{sb.species}</span>: {sb.count}</li>)}
                </ul>
            </p>
        </div>
    );
}