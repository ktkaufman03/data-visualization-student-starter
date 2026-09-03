import { useEffect, useMemo, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { csvParse } from 'd3-dsv';
import { useDimensions } from '../../helpers/useDimensions';

interface Summary {
    rows: number;
    columns: number;
    species_breakdown: { [key: string]: number }
}

// Several fields of the data are ignored because
// we just don't need them.
interface CottontailRow {
    // gbifID: number;
    // datasetKey: string;
    occurrenceID: string;

    // We don't care about these because we've already established
    // that everything's a cottontail (genus Sylvilagus)
    // kingdom: string;
    // phylum: string;
    // class: string;
    // order: string;
    // family: string;
    // genus: string;
    species: string;
    // infraspecificEpithet: string;
    // taxonRank: string;

    // the "scientificName" field includes the person who named it, which is irrelevant
    // scientificName: string; 
    // verbatimScientificName: string;
    // verbatimScientificNameAuthorship: string;
    // countryCode: string;
    // locality: string;
    stateProvince: string;
    occurrenceStatus: string;
    // individualCount: number;
    // publishingOrgKey: string;
    decimalLatitude: number;
    decimalLongitude: number;
    // coordinateUncertaintyInMeters: number;
    // coordinatePrecision: number;
    elevation: number;
    // elevationAccuracy: number;
    // depth: number;
    // depthAccuracy: number;
    // eventDate: string;
    day: number;
    month: number;
    year: number;
    // taxonKey: string;
    // speciesKey: string;
    // basisOfRecord: string;
    // institutionCode: string;
    // collectionCode: string;
    // catalogNumber: number;
    // recordNumber: number;
    // identifiedBy: string;
    // dateIdentified: string;
    // license: string;
    // rightsHolder: string;
    // recordedBy: string;
    // typeStatus: string;
    // establishmentMeans: string;
    // lastInterpreted: string;
    // mediaType: string;
    // issue: string;
}

const DATA_URL = `${import.meta.env.BASE_URL}/data/inaturalist-ne-cottontails/0000410-260903112359142.csv`;

const FONT_SIZE = 28;
const LINE_HEIGHT = FONT_SIZE * 1.2;

export function LoadingAndSummarizingData() {
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
                console.log(converted);
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
        console.log(JSON.stringify(data, null, 2));

        let species_breakdown: { [key: string]: number } = {};

        for (let entry of data) {
            if (!(entry.species in species_breakdown))
                species_breakdown[entry.species] = 0;
            species_breakdown[entry.species]++;
        }

        return {
            rows: data.length,
            columns: Object.keys(data[0]).length,
            species_breakdown
        };
    }, [data]);

    useEffect(() => {
        const svg = svgRef.current;
        if (!svg || dimensions.width === 0 || dimensions.height === 0 || !summary) return;

        const centerX = dimensions.width / 2;
        const centerY = dimensions.height / 2;

        select(svg)
            .selectAll('text')
            .data([summary])
            .join('text')
            .attr('x', centerX)
            .attr('y', centerY)
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'middle')
            .attr('font-size', FONT_SIZE)
            .selectAll('tspan')
            .data((d) => [
                `Rows: ${d.rows}`,
                `Columns: ${d.columns}`,
                ...Object.keys(summary.species_breakdown).map(k => `Species ${k}: ${summary.species_breakdown[k]}`)
            ])
            .join('tspan')
            .attr('x', centerX)
            .attr('dy', (_d, i) => (i === 0 ? 0 : LINE_HEIGHT))
            .text((d) => d);
    }, [dimensions, summary]);

    return (
        <div ref={divRef} className="relative w-full h-full">
            <svg
                ref={svgRef}
                className="absolute inset-0 w-full h-full"
                role="img"
                aria-label="Summary of the NE Cottontail dataset"
            ></svg>
        </div>
    );
}