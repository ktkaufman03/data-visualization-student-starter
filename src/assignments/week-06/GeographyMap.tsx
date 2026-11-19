import { useEffect, useId, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { APIProvider, Map as GoogleMap, useMap } from '@vis.gl/react-google-maps';
import Supercluster from 'supercluster';
import { merge } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import statesTopology from 'us-atlas/states-10m.json';
import type { CottontailRow } from './types';
import { speciesColor } from './species';

// google maps demo key
const MAPS_API_KEY: string = 'AIzaSyC23xtNxenZmWJ0yz_uW5A_nZnDi1Mz9NE';

// Roughly the six New England states, from southwest Connecticut to northern Maine.
// The map fits these bounds to whatever size its container is.
const NEW_ENGLAND_BOUNDS = {
    north: 47.5,
    south: 40.9,
    west: -73.8,
    east: -66.9,
    padding: 16
};

// State FIPS codes: Connecticut, Maine, Massachusetts, New Hampshire, Rhode Island, Vermont.
const NEW_ENGLAND_FIPS = new Set(["09", "23", "25", "33", "44", "50"]);

// One outline per landmass (mainland plus islands like Nantucket), with the borders between
// the six states merged away. Computed once when the module loads.
const NEW_ENGLAND_OUTLINES: google.maps.LatLngLiteral[][] = (() => {
    const topology = statesTopology as unknown as Topology<{ states: GeometryCollection }>;
    const states = topology.objects.states.geometries.filter((g) => NEW_ENGLAND_FIPS.has(String(g.id)));
    return merge(topology, states as Parameters<typeof merge>[1]).coordinates
        .map((polygon) => polygon[0].map(([lng, lat]) => ({ lat, lng })));
})();

// Positive for counter-clockwise rings (treating lng as x and lat as y).
function signedArea(ring: google.maps.LatLngLiteral[]) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        sum += a.lng * b.lat - b.lng * a.lat;
    }
    return sum / 2;
}

// Grays out everything outside New England: a world-sized polygon with New England cut out.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function NewEnglandMask() {
    const map = useMap();

    useEffect(() => {
        if (!map) return;

        // Clockwise around the whole world. Mercator stops at about ±85°.
        const world = [
            { lat: 85, lng: -179.99 }, { lat: 85, lng: 0 }, { lat: 85, lng: 179.99 },
            { lat: -85, lng: 179.99 }, { lat: -85, lng: 0 }, { lat: -85, lng: -179.99 }
        ];
        // Google Maps only cuts a hole when it winds the opposite way to the outer path.
        const worldClockwise = signedArea(world) < 0;
        const holes = NEW_ENGLAND_OUTLINES.map((ring) =>
            (signedArea(ring) < 0) === worldClockwise ? [...ring].reverse() : ring
        );

        const mask = new google.maps.Polygon({
            map,
            paths: [world, ...holes],
            fillColor: "#4b5563",
            fillOpacity: 0.35,
            strokeColor: "#4b5563",
            strokeOpacity: 0.8,
            strokeWeight: 1,
            clickable: false
        });

        return () => mask.setMap(null);
    }, [map]);

    return null;
}

interface PointProps {
    occurrenceID: string;
    species: string;
    stateProvince: string;
    year: number;
}

// Past this zoom level every observation is drawn individually.
const CLUSTER_MAX_ZOOM = 14;

// Draws observations, grouping nearby ones into clusters until the map is zoomed in.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function ObservationLayer({ points, species }: { points: CottontailRow[]; species: string[] }) {
    const map = useMap();

    // One cluster index per species, so a cluster keeps its species' color and the
    // rare species isn't swallowed by clusters of the common one.
    const indexes = useMemo(
        () => new Map(species.map((sp) => [
            sp,
            new Supercluster<PointProps>({ radius: 60, maxZoom: CLUSTER_MAX_ZOOM }).load(
                points.filter((d) => d.species === sp).map((d) => ({
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [d.decimalLongitude, d.decimalLatitude] },
                    properties: {
                        occurrenceID: d.occurrenceID,
                        species: d.species,
                        stateProvince: d.stateProvince,
                        year: d.year
                    }
                }))
            )
        ])),
        [points, species]
    );

    useEffect(() => {
        if (!map) return;

        // Rarer species are drawn on top so they aren't buried under the common one.
        const counts = d3.rollup(points, (v) => v.length, (d) => d.species);

        const layer = new google.maps.Data({ map });
        layer.setStyle((feature) => {
            const sp = feature.getProperty("species") as string;
            const zIndex = points.length - (counts.get(sp) ?? 0);
            const count = feature.getProperty("point_count") as number | undefined;

            if (count) {
                return {
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        // Grows slowly with count so big clusters don't cover the map.
                        scale: 8 + 2 * Math.log2(count),
                        fillColor: speciesColor(sp, species),
                        fillOpacity: 0.85,
                        strokeColor: "#ffffff",
                        strokeWeight: 2
                    },
                    label: {
                        text: String(feature.getProperty("point_count_abbreviated")),
                        color: "#ffffff",
                        fontSize: "11px",
                        fontWeight: "600"
                    },
                    cursor: "pointer",
                    zIndex,
                    title: `${d3.format(",")(count)} ${sp} observations (click to zoom in)`
                };
            }

            return {
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 4,
                    fillColor: speciesColor(sp, species),
                    fillOpacity: 0.8,
                    strokeColor: "#ffffff",
                    strokeWeight: 1
                },
                zIndex,
                // Native tooltip on hover.
                title: `${sp}\n${feature.getProperty("stateProvince")}, ${feature.getProperty("year")}`
            };
        });

        // The area and zoom the layer currently has features for.
        let loaded: { zoom: number; bbox: [number, number, number, number] } | null = null;

        // Bring the layer up to date with the current view whenever the map stops moving.
        const update = () => {
            const bounds = map.getBounds();
            const rawZoom = map.getZoom();
            if (!bounds || rawZoom === undefined) return;

            const zoom = Math.round(rawZoom);
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();

            // Small pans that stay inside the already-loaded area need no update at all.
            if (
                loaded && loaded.zoom === zoom &&
                sw.lng() >= loaded.bbox[0] && sw.lat() >= loaded.bbox[1] &&
                ne.lng() <= loaded.bbox[2] && ne.lat() <= loaded.bbox[3]
            ) return;

            // Load half a screen of margin on every side so the next few pans are covered.
            const dLng = (ne.lng() - sw.lng()) / 2;
            const dLat = (ne.lat() - sw.lat()) / 2;
            const bbox: [number, number, number, number] = [
                Math.max(-180, sw.lng() - dLng),
                Math.max(-90, sw.lat() - dLat),
                Math.min(180, ne.lng() + dLng),
                Math.min(90, ne.lat() + dLat)
            ];

            // Give every cluster and point a stable id. Cluster ids are only unique within one
            // species' index, so the species is part of the key.
            const next = new Map<string, GeoJSON.Feature>();
            for (const [sp, index] of indexes) {
                for (const f of index.getClusters(bbox, zoom)) {
                    const key = "cluster_id" in f.properties
                        ? `${sp}:cluster:${f.properties.cluster_id}`
                        : `${sp}:point:${f.properties.occurrenceID}`;
                    next.set(key, {
                        type: "Feature",
                        id: key,
                        geometry: f.geometry,
                        properties: { ...f.properties, species: sp }
                    });
                }
            }

            // Only touch what changed, so clusters that are still valid stay on screen untouched.
            const stale: google.maps.Data.Feature[] = [];
            layer.forEach((f) => {
                if (!next.has(f.getId() as string)) stale.push(f);
            });
            stale.forEach((f) => layer.remove(f));

            const added = Array.from(next.entries())
                .filter(([key]) => !layer.getFeatureById(key))
                .map(([, f]) => f);
            if (added.length) layer.addGeoJson({ type: "FeatureCollection", features: added });

            loaded = { zoom, bbox };
        };

        const idleListener = map.addListener("idle", update);
        update();

        // Clicking a cluster zooms in just far enough to split it apart.
        const clickListener = layer.addListener("click", (e: google.maps.Data.MouseEvent) => {
            const clusterId = e.feature.getProperty("cluster_id") as number | undefined;
            const index = indexes.get(e.feature.getProperty("species") as string);
            if (clusterId === undefined || !index || !e.latLng) return;

            map.setZoom(index.getClusterExpansionZoom(clusterId));
            map.panTo(e.latLng);
        });

        return () => {
            idleListener.remove();
            clickListener.remove();
            layer.setMap(null);
        };
    }, [map, points, species, indexes]);

    return null;
}

type MapMode = "points" | "heatmap";

// Months are counted from year 0 so a month/year pair is a single slider value.
const monthIndex = (d: CottontailRow) => d.year * 12 + (d.month - 1);
const formatMonth = (i: number) => d3.timeFormat("%b %Y")(new Date(Math.floor(i / 12), i % 12));

interface MapSettingsProps {
    mode: MapMode;
    onModeChange: (mode: MapMode) => void;
    extent: [number, number];
    range: [number, number];
    onRangeChange: (range: [number, number]) => void;
}

function MapSettings({ mode, onModeChange, extent, range, onRangeChange }: MapSettingsProps) {
    const radioName = useId();
    const [min, max] = extent;
    const [lo, hi] = range;
    const pct = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * 100);

    // Two range inputs stacked on one track. The inputs ignore the mouse and only their
    // thumbs catch it, so either thumb can be grabbed.
    const thumb = "pointer-events-none absolute inset-0 m-0 h-full w-full appearance-none bg-transparent " +
        "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 " +
        "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black " +
        "[&::-webkit-slider-thumb]:cursor-pointer " +
        "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 " +
        "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black " +
        "[&::-moz-range-thumb]:cursor-pointer";

    return (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div role="radiogroup" aria-label="Map style" className="flex items-center gap-3 rounded border border-gray-300 px-2 py-1">
                {([["points", "Points"], ["heatmap", "Heatmap"]] as const).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-1 cursor-pointer">
                        <input
                            type="radio"
                            name={radioName}
                            value={value}
                            checked={mode === value}
                            onChange={() => onModeChange(value)}
                            className="accent-black cursor-pointer"
                        />
                        {label}
                    </label>
                ))}
            </div>

            <div className="flex items-center gap-3">
                <span className="w-16 text-right tabular-nums">{formatMonth(lo)}</span>
                <div className="relative h-5 w-64">
                    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-gray-200" />
                    <div
                        className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-gray-500"
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
        </div>
    );
}

export function GeographyMap({ data }: { data: CottontailRow[] | null }) {
    const [mode, setMode] = useState<MapMode>("points");
    // null means the full date range; set once the slider is first moved.
    const [range, setRange] = useState<[number, number] | null>(null);
    const [appliedRange, setAppliedRange] = useState<[number, number] | null>(null);

    // Missing coordinates parse as NaN (or 0 for empty strings), and an unknown species
    // has no color, so skip both.
    const points = useMemo(
        () => data?.filter((d) => d.decimalLatitude && d.decimalLongitude && d.species !== "Unknown") ?? [],
        [data]
    );
    // From all points, not just the visible ones, so each species keeps its color when filtered.
    const species = useMemo(
        () => Array.from(new Set(points.map((d) => d.species))).sort(d3.ascending),
        [points]
    );

    // The slider spans the earliest to latest month in the whole dataset.
    const extent = useMemo<[number, number] | null>(() => {
        const [min, max] = d3.extent(data ?? [], monthIndex);
        return min === undefined || max === undefined ? null : [min, max];
    }, [data]);

    // Re-clustering 16k points on every slider step would stall the map, so the filter is
    // applied once the slider has been still for a moment.
    useEffect(() => {
        const timeout = setTimeout(() => setAppliedRange(range), 250);
        return () => clearTimeout(timeout);
    }, [range]);

    const visiblePoints = useMemo(() => {
        if (!appliedRange) return points;
        const [lo, hi] = appliedRange;
        return points.filter((d) => monthIndex(d) >= lo && monthIndex(d) <= hi);
    }, [points, appliedRange]);

    return (
        <div className="flex flex-col w-full h-full gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>Observations: {d3.format(",")(visiblePoints.length)}</span>
                {species.map((sp) => (
                    <span key={sp} className="flex items-center gap-1">
                        <span className="inline-block w-3 h-3 rounded-full" style={{ background: speciesColor(sp, species) }} />
                        <i>{sp}</i>
                    </span>
                ))}
            </div>

            {extent && (
                <MapSettings
                    mode={mode}
                    onModeChange={setMode}
                    extent={extent}
                    range={range ?? extent}
                    onRangeChange={setRange}
                />
            )}

            <div className="flex-1 min-h-0 overflow-hidden rounded">
                <APIProvider apiKey={MAPS_API_KEY}>
                    <GoogleMap
                        defaultBounds={NEW_ENGLAND_BOUNDS}
                        gestureHandling="greedy"
                        style={{ width: "100%", height: "100%" }}
                    >
                        <NewEnglandMask />
                        <ObservationLayer points={visiblePoints} species={species} />
                    </GoogleMap>
                </APIProvider>
            </div>
        </div>
    );
}
