import { useEffect, useId, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { APIProvider, ColorScheme, Map as GoogleMap, useMap } from '@vis.gl/react-google-maps';
import Supercluster from 'supercluster';
import { merge } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import statesTopology from 'us-atlas/states-10m.json';
import type { CottontailRow } from './types';
import { speciesColor } from './species';
import { DensityHeatmap } from './DensityHeatmap';
import { TimeRangeSlider, type TimeRangeSliderProps } from './TimeRangeSlider';
import { useTimeFilter } from './useTimeFilter';
import { useTheme } from '../../helpers/theme';

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

// Legend swatch for the heatmap: the species colors blended in Lab, as DensityHeatmap mixes them.
function speciesMixGradient(species: string[]) {
    const mix = d3.piecewise(d3.interpolateLab, species.map((sp) => speciesColor(sp, species)));
    return `linear-gradient(to right, ${d3.range(0, 1.01, 0.1).map((t) => mix(t)).join(", ")})`;
}

interface MapSettingsProps {
    mode: MapMode;
    onModeChange: (mode: MapMode) => void;
    timeSlider: TimeRangeSliderProps | null;
}

function MapSettings({ mode, onModeChange, timeSlider }: MapSettingsProps) {
    const radioName = useId();

    return (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div role="radiogroup" aria-label="Map style" className="flex items-center gap-3 rounded border border-gray-300 px-2 py-1 dark:border-gray-600">
                {([["points", "Points"], ["heatmap", "Heatmap"]] as const).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-1 cursor-pointer">
                        <input
                            type="radio"
                            name={radioName}
                            value={value}
                            checked={mode === value}
                            onChange={() => onModeChange(value)}
                            className="accent-black cursor-pointer dark:accent-white"
                        />
                        {label}
                    </label>
                ))}
            </div>

            {timeSlider && <TimeRangeSlider {...timeSlider} />}
        </div>
    );
}

// Missing coordinates parse as NaN (or 0 for empty strings), and an unknown species
// has no color, so skip both.
const isMappable = (d: CottontailRow) => d.decimalLatitude && d.decimalLongitude && d.species !== "Unknown";

export function GeographyMap({ data }: { data: CottontailRow[] | null }) {
    const [mode, setMode] = useState<MapMode>("points");
    const { theme } = useTheme();
    // This tab's own time range, independent of the Bars tab.
    const { filtered, timeSlider } = useTimeFilter(data);

    // From all observations, not just the visible ones, so each species keeps its color when filtered.
    const species = useMemo(
        () => Array.from(new Set((data ?? []).filter(isMappable).map((d) => d.species))).sort(d3.ascending),
        [data]
    );
    const visiblePoints = useMemo(() => (filtered ?? []).filter(isMappable), [filtered]);

    return (
        <div className="flex flex-col w-full h-full gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>Observations: {d3.format(",")(visiblePoints.length)}</span>
                {mode === "points" ? species.map((sp) => (
                    <span key={sp} className="flex items-center gap-1">
                        <span className="inline-block w-3 h-3 rounded-full" style={{ background: speciesColor(sp, species) }} />
                        <i>{sp}</i>
                    </span>
                )) : species.length > 0 && (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <i>{species[0]}</i>
                        <span className="inline-block h-3 w-32 rounded-sm" style={{ background: speciesMixGradient(species) }} />
                        <i>{species[species.length - 1]}</i>
                        <span className="text-gray-600 dark:text-gray-400">· in-between colors are a mix · fainter means fewer observations</span>
                    </span>
                )}
            </div>

            <MapSettings mode={mode} onModeChange={setMode} timeSlider={timeSlider} />

            <div className="flex-1 min-h-0 overflow-hidden rounded">
                <APIProvider apiKey={MAPS_API_KEY}>
                    <GoogleMap
                        // Google only reads the color scheme when the map is created, so a new
                        // theme means a new map (which also resets the view to New England).
                        key={theme}
                        colorScheme={theme === "dark" ? ColorScheme.DARK : ColorScheme.LIGHT}
                        defaultBounds={NEW_ENGLAND_BOUNDS}
                        gestureHandling="greedy"
                        style={{ width: "100%", height: "100%" }}
                    >
                        <NewEnglandMask />
                        {mode === "points"
                            ? <ObservationLayer points={visiblePoints} species={species} />
                            : <DensityHeatmap points={visiblePoints} species={species} />}
                    </GoogleMap>
                </APIProvider>
            </div>
        </div>
    );
}
