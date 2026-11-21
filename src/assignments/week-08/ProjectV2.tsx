import { useEffect, useState } from 'react';
import { csvParse } from 'd3-dsv';
import type { CottontailRow } from './types';
import { toSpecies } from './species';
import { SpeciesBarChart } from './SpeciesBarChart';
import { GeographyMap } from './GeographyMap';

const DATA_URL = `${import.meta.env.BASE_URL}/data/inaturalist-ne-cottontails-v3/inat_all_cottontails_ne.csv`;

// Empty cells in the CSV are nulls in the source data.
function orNull<T>(value: string | undefined, convert: (value: string) => T): T | null {
    return value ? convert(value) : null;
}

const TABS = [
    { id: 'geography', label: 'Geography' },
    { id: 'bars', label: 'Bars' }
] as const;

type TabId = typeof TABS[number]['id'];

export function ProjectV2() {
    const [data, setData] = useState<CottontailRow[] | null>(null);
    const [tab, setTab] = useState<TabId>('geography');

    useEffect(() => {
        let cancelled = false;

        fetch(DATA_URL)
            .then((response) => response.text())
            .then((text) => {
                if (cancelled) return;
                const parsed = csvParse(text);
                const converted: CottontailRow[] = parsed.map((row) => ({
                    occurrenceID: +row.occurrenceID,
                    // Subspecies are merged into their species.
                    species: row.species ? toSpecies(row.species) : "Unknown",
                    stateProvince: row.stateProvince || "Unknown",
                    // Written by pandas as "True"/"False".
                    isAlive: orNull(row.isAlive, (v) => v === "True"),
                    // Written as "2.0"/"8.0", since pandas stores a column with blanks as floats.
                    lifeStage: orNull(row.lifeStage, Number),
                    decimalLatitude: +row.decimalLatitude,
                    decimalLongitude: +row.decimalLongitude,
                    day: +row.day,
                    month: +row.month,
                    year: +row.year,
                    licenseCode: row.licenseCode || null,
                    photoID: +row.photoID,
                    photoLicenseCode: row.photoLicenseCode || null,
                    author: row.author ?? ""
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

    return (
        <div className="flex flex-col w-full h-full gap-4 p-4">
            <div role="tablist" className="flex gap-4 border-b border-gray-200 dark:border-gray-700">
                {TABS.map((t) => {
                    const isActive = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            id={`tab-${t.id}`}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            aria-controls={`panel-${t.id}`}
                            className={`-mb-px border-b-2 px-1 pb-2 text-sm cursor-pointer ${
                                isActive
                                    ? "border-black text-black dark:border-white dark:text-white"
                                    : "border-transparent text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
                            }`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {/* Both panels stay mounted so each view keeps its state (e.g. hidden species) across tab switches. */}
            <div
                role="tabpanel"
                id="panel-geography"
                aria-labelledby="tab-geography"
                hidden={tab !== 'geography'}
                className="flex-1 min-h-0"
            >
                <GeographyMap data={data} />
            </div>
            <div
                role="tabpanel"
                id="panel-bars"
                aria-labelledby="tab-bars"
                hidden={tab !== 'bars'}
                className="flex-1 min-h-0"
            >
                <SpeciesBarChart data={data} />
            </div>
        </div>
    );
}
