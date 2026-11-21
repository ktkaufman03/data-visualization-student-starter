import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as d3 from 'd3';
import { APIProvider, ColorScheme, Map as GoogleMap, useMap } from '@vis.gl/react-google-maps';
import Supercluster from 'supercluster';
import { merge } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import statesTopology from 'us-atlas/states-10m.json';
import type { CottontailRow } from './types';
import { isGenusOnly, speciesColor } from './species';
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

// The states left un-grayed on the map: the six New England states, plus New York since the
// dataset has a few observations there. State FIPS codes: Connecticut, Maine, Massachusetts,
// New Hampshire, New York, Rhode Island, Vermont.
const REGION_FIPS = new Set(["09", "23", "25", "33", "36", "44", "50"]);

// One outline per landmass (mainland plus islands like Nantucket and Long Island), with the
// borders between the states merged away. Computed once when the module loads.
const REGION_OUTLINES: google.maps.LatLngLiteral[][] = (() => {
    const topology = statesTopology as unknown as Topology<{ states: GeometryCollection }>;
    const states = topology.objects.states.geometries.filter((g) => REGION_FIPS.has(String(g.id)));
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

// Grays out everything outside the region: a world-sized polygon with the region cut out.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function RegionMask() {
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
        const holes = REGION_OUTLINES.map((ring) =>
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
    occurrenceID: number;
    species: string;
}

// Past this zoom level every observation is drawn individually.
const CLUSTER_MAX_ZOOM = 14;

// iNaturalist "Life Stage" annotation values found in the data.
const LIFE_STAGES: Record<number, string> = { 2: "adult", 8: "juvenile" };

// Places its children on the map at `position`, moving with the map as it pans and zooms.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function MapOverlay({ position, children }: { position: google.maps.LatLng; children: ReactNode }) {
    const map = useMap();
    const [container] = useState(() => {
        const div = document.createElement("div");
        div.style.position = "absolute";
        // Never catch the mouse, or hovering the tooltip would end the hover that opened it.
        div.style.pointerEvents = "none";
        return div;
    });

    useEffect(() => {
        if (!map) return;
        const overlay = new google.maps.OverlayView();
        // The float pane sits above the markers and their labels.
        overlay.onAdd = () => overlay.getPanes()?.floatPane.appendChild(container);
        overlay.onRemove = () => container.remove();
        overlay.draw = () => {
            const p = overlay.getProjection()?.fromLatLngToDivPixel(position);
            if (!p) return;
            container.style.left = `${p.x}px`;
            container.style.top = `${p.y}px`;
        };
        overlay.setMap(map);
        return () => overlay.setMap(null);
    }, [map, container, position]);

    return createPortal(children, container);
}

// The card shown next to a single observation while it's hovered.
function ObservationTooltip({ observation }: { observation: CottontailRow }) {
    const lifeStage = observation.lifeStage === null ? null : LIFE_STAGES[observation.lifeStage];
    const details = [
        lifeStage,
        observation.isAlive === false ? "deceased" : null,
        `observed ${observation.month}/${observation.day}/${observation.year}`
    ].filter(Boolean).join(" · ");

    return (
        // Sits to the right of the dot, vertically centered on it, with a caret pointing back at it.
        <div className="absolute left-0 top-0 translate-x-3 -translate-y-1/2">
            <div className="relative whitespace-nowrap rounded-xl bg-white px-4 py-2 text-gray-900 shadow-lg ring-1 ring-black/5 dark:bg-gray-800 dark:text-gray-100 dark:ring-white/10">
                <div className="absolute left-0 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-white dark:bg-gray-800" />
                <p className="relative text-lg font-semibold italic leading-tight">{observation.species}</p>
                <p className="relative text-sm text-gray-600 dark:text-gray-300">{details}</p>
                <p className="relative text-xs text-gray-500 dark:text-gray-400">
                    {observation.stateProvince} · by {observation.author}
                </p>
            </div>
        </div>
    );
}

// Draws observations, grouping nearby ones into clusters until the map is zoomed in.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function ObservationLayer({ points, species }: { points: CottontailRow[]; species: string[] }) {
    const map = useMap();
    // The single observation under the mouse, and where its dot is.
    const [hovered, setHovered] = useState<{ observation: CottontailRow; position: google.maps.LatLng } | null>(null);

    const byId = useMemo(() => new Map(points.map((d) => [d.occurrenceID, d])), [points]);

    // One cluster index per species, so a cluster keeps its species' color and the
    // rare species isn't swallowed by clusters of the common one.
    const indexes = useMemo(
        () => new Map(species.map((sp) => [
            sp,
            new Supercluster<PointProps>({ radius: 60, maxZoom: CLUSTER_MAX_ZOOM }).load(
                points.filter((d) => d.species === sp).map((d) => ({
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [d.decimalLongitude, d.decimalLatitude] },
                    properties: { occurrenceID: d.occurrenceID, species: d.species }
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
                        fillColor: speciesColor(sp),
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
                    fillColor: speciesColor(sp),
                    fillOpacity: 0.8,
                    strokeColor: "#ffffff",
                    strokeWeight: 1
                },
                zIndex
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

        // Hovering a single observation (not a cluster) shows its tooltip.
        const overListener = layer.addListener("mouseover", (e: google.maps.Data.MouseEvent) => {
            if (e.feature.getProperty("cluster_id") !== undefined) return;
            const observation = byId.get(e.feature.getProperty("occurrenceID") as number);
            const geometry = e.feature.getGeometry();
            if (!observation || !(geometry instanceof google.maps.Data.Point)) return;
            setHovered({ observation, position: geometry.get() });
        });
        const outListener = layer.addListener("mouseout", () => setHovered(null));
        // Zooming can swap the hovered dot into a cluster without a mouseout, so close the tooltip.
        const zoomListener = map.addListener("zoom_changed", () => setHovered(null));

        return () => {
            idleListener.remove();
            clickListener.remove();
            overListener.remove();
            outListener.remove();
            zoomListener.remove();
            layer.setMap(null);
            setHovered(null);
        };
    }, [map, points, species, indexes, byId]);

    return hovered && (
        <MapOverlay position={hovered.position}>
            <ObservationTooltip observation={hovered.observation} />
        </MapOverlay>
    );
}

type MapMode = "points" | "heatmap";

// Legend swatch for the heatmap: the species colors blended in Lab, as DensityHeatmap mixes them.
function speciesMixGradient(species: string[]) {
    const mix = d3.piecewise(d3.interpolateLab, species.map((sp) => speciesColor(sp)));
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

    // The heatmap mixes species colors by share, so observations not identified to a species
    // are left out of it rather than diluting the mix.
    const heatmapSpecies = useMemo(() => species.filter((sp) => !isGenusOnly(sp)), [species]);
    const heatmapPoints = useMemo(() => visiblePoints.filter((d) => !isGenusOnly(d.species)), [visiblePoints]);

    return (
        <div className="flex flex-col w-full h-full gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>
                    Observations: {d3.format(",")(mode === "points" ? visiblePoints.length : heatmapPoints.length)}
                </span>
                {mode === "points" ? species.map((sp) => (
                    <span key={sp} className="flex items-center gap-1">
                        <span className="inline-block w-3 h-3 rounded-full" style={{ background: speciesColor(sp) }} />
                        <i>{sp}</i>
                    </span>
                )) : heatmapSpecies.length > 0 && (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <i>{heatmapSpecies[0]}</i>
                        <span className="inline-block h-3 w-32 rounded-sm" style={{ background: speciesMixGradient(heatmapSpecies) }} />
                        <i>{heatmapSpecies[heatmapSpecies.length - 1]}</i>
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
                        <RegionMask />
                        {mode === "points"
                            ? <ObservationLayer points={visiblePoints} species={species} />
                            : <DensityHeatmap points={heatmapPoints} species={heatmapSpecies} />}
                    </GoogleMap>
                </APIProvider>
            </div>
        </div>
    );
}
