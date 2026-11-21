import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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

const MAPS_API_KEY: string = 'AIzaSyAnRfJkpiJJus9f5jcooGtzVFsl7-rd-RI';

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

// Flags shown as badges on a dot, or on a cluster if any observation in it has them.
interface BadgeFlags {
    hasPhoto: boolean;
    hasJuvenile: boolean;
}

interface PointProps extends BadgeFlags {
    occurrenceID: number;
    species: string;
}

// Whether the tooltip can show a photo: only of living cottontails, so nobody is shown a dead
// bunny, and only licensed photos, since unlicensed ones aren't in the open-data bucket.
const hasLivingPhoto = (d: CottontailRow) => d.isAlive === true && d.photoLicenseCode !== null;

// iNaturalist's "Juvenile" life stage value.
const JUVENILE = 8;

// Radius in pixels of a single observation's dot, and of a cluster of `count` observations
// (grows slowly with count so big clusters don't cover the map).
const POINT_RADIUS = 4;
const clusterRadius = (count: number) => 8 + 2 * Math.log2(count);

// Badges are small dark circles with a white glyph, sitting on the upper edge of a dot or cluster:
// the camera at the upper right, the juvenile "J" at the upper left.
type BadgeKind = "photo" | "juvenile";
const BADGE_SIZE = 13;
const BADGE_GLYPHS: Record<BadgeKind, (c: number) => string> = {
    photo: (c) =>
        `<rect x="${c - 3}" y="${c - 1.5}" width="6" height="4" rx="0.8" fill="#ffffff"/>` +
        `<rect x="${c - 1}" y="${c - 2.6}" width="2" height="1.4" rx="0.3" fill="#ffffff"/>` +
        `<circle cx="${c}" cy="${c + 0.5}" r="1.2" fill="#1f2937"/>`,
    juvenile: (c) =>
        `<text x="${c}" y="${c + 3}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" ` +
        `font-size="8.5" font-weight="700" fill="#ffffff">J</text>`
};

function badgeSvgUrl(kind: BadgeKind) {
    const c = BADGE_SIZE / 2;
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_SIZE}" height="${BADGE_SIZE}" viewBox="0 0 ${BADGE_SIZE} ${BADGE_SIZE}">` +
        `<circle cx="${c}" cy="${c}" r="${c - 1}" fill="#1f2937" stroke="#ffffff" stroke-width="1"/>` +
        BADGE_GLYPHS[kind](c) +
        `</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// For the legend.
const BADGE_URLS: Record<BadgeKind, string> = { photo: badgeSvgUrl("photo"), juvenile: badgeSvgUrl("juvenile") };

// A badge as a map icon, placed against a dot or cluster of the given radius. The badge is its
// own feature at the same location, so the anchor shifts it up and to the side, onto the edge.
// Icons are cached, since there are only a few kinds and radii.
const badgeIcons = new Map<string, google.maps.Icon>();
function badgeIcon(kind: BadgeKind, radius: number) {
    const key = `${kind}:${radius.toFixed(1)}`;
    let icon = badgeIcons.get(key);
    if (!icon) {
        // Center the badge just outside the circle, 45° up from its center.
        const offset = (radius + BADGE_SIZE / 2 - 1) * Math.SQRT1_2;
        const dx = kind === "photo" ? offset : -offset;
        icon = {
            url: BADGE_URLS[kind],
            size: new google.maps.Size(BADGE_SIZE, BADGE_SIZE),
            anchor: new google.maps.Point(BADGE_SIZE / 2 - dx, BADGE_SIZE / 2 + offset)
        };
        badgeIcons.set(key, icon);
    }
    return icon;
}

// Past this zoom level every observation is drawn individually.
const CLUSTER_MAX_ZOOM = 14;

// iNaturalist "Life Stage" annotation values found in the data.
const LIFE_STAGES: Record<number, string> = { 2: "adult", 8: "juvenile" };

const observationUrl = (occurrenceID: number) => `https://www.inaturalist.org/observations/${occurrenceID}`;

// Shown before opening an observation that isn't known to be of a living bunny.
const UPSETTING_WARNING = "This observation may be upsetting, are you sure you want to continue?";

// How long a tooltip stays open after the cursor leaves its dot, so it can be moved onto the tooltip.
const TOOLTIP_HIDE_DELAY = 200;

// iNaturalist keeps each photo's original file extension, so try the common ones in turn.
// Only openly licensed photos are in this bucket.
const PHOTO_EXTENSIONS = ["jpg", "jpeg", "JPG", "png"];
// "medium" is up to 500px on its long side, enough to stay sharp in the tooltip's 128px frame
// on high-density screens ("square" is only 75x75 and blurs when scaled up).
const photoUrl = (photoID: number, extension: string) =>
    `https://inaturalist-open-data.s3.amazonaws.com/photos/${photoID}/medium.${extension}`;

// "cc-by-nc" -> "CC BY-NC", "cc0" -> "CC0", as licenses are usually written in credits.
function formatLicense(code: string) {
    return code.startsWith("cc-") ? `CC ${code.slice(3).toUpperCase()}` : code.toUpperCase();
}

// Places its children on the map at `position`, moving with the map as it pans and zooms.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function MapOverlay({ position, children }: { position: google.maps.LatLng; children: ReactNode }) {
    const map = useMap();
    const [container] = useState(() => {
        const div = document.createElement("div");
        div.style.position = "absolute";
        // The container itself has no size; only the children that opt in catch the mouse.
        div.style.pointerEvents = "none";
        return div;
    });

    useEffect(() => {
        if (!map) return;
        // Clicks, drags and scrolling on the overlay stay on it instead of moving the map.
        google.maps.OverlayView.preventMapHitsAndGesturesFrom(container);
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

interface ObservationTooltipProps {
    observation: CottontailRow;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

// The card shown next to a single observation while it's hovered.
function ObservationTooltip({ observation, onMouseEnter, onMouseLeave }: ObservationTooltipProps) {
    // Which of PHOTO_EXTENSIONS is being tried; past the end means no photo could be found.
    const [extensionIndex, setExtensionIndex] = useState(0);
    const showPhoto = hasLivingPhoto(observation) && extensionIndex < PHOTO_EXTENSIONS.length;

    const lifeStage = observation.lifeStage === null ? null : LIFE_STAGES[observation.lifeStage];
    const details = [
        lifeStage,
        // Unrecorded (null) gets no marker either way.
        observation.isAlive === true ? "alive" : observation.isAlive === false ? "deceased" : null,
        `observed ${observation.month}/${observation.day}/${observation.year}`
    ].filter(Boolean).join(" · ");

    return (
        // Sits to the right of the dot, vertically centered on it, with a caret pointing back at it.
        <div
            className="pointer-events-auto absolute left-0 top-0 translate-x-4 -translate-y-1/2"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="relative flex items-center gap-4 whitespace-nowrap rounded-2xl bg-white p-3 pr-5 text-gray-900 shadow-xl ring-1 ring-black/5 dark:bg-gray-800 dark:text-gray-100 dark:ring-white/10">
                <div className="absolute left-0 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-white dark:bg-gray-800" />
                {showPhoto && (
                    <img
                        src={photoUrl(observation.photoID, PHOTO_EXTENSIONS[extensionIndex])}
                        alt={`Photo of the observed ${observation.species}`}
                        className="relative h-32 w-32 shrink-0 rounded-xl bg-gray-100 object-cover dark:bg-gray-700"
                        // Wrong extension: try the next one, and leave the image out once they run out.
                        onError={() => setExtensionIndex((i) => i + 1)}
                    />
                )}
                <div className={`relative ${showPhoto ? "" : "pl-2"}`}>
                    <p className="text-xl font-semibold italic leading-tight">{observation.species}</p>
                    <p className="mt-1 text-base text-gray-600 dark:text-gray-300">{details}</p>
                    <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                        {observation.stateProvince} · by{" "}
                        <a
                            href={observationUrl(observation.occurrenceID)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View this observation on iNaturalist"
                            className="underline decoration-gray-400 underline-offset-2 hover:text-gray-900 hover:decoration-current dark:hover:text-gray-100"
                            onClick={(e) => {
                                // The observation page may show a dead (or unrecorded-status) bunny,
                                // so check before opening anything that isn't known to be alive.
                                if (observation.isAlive !== true && !window.confirm(UPSETTING_WARNING)) {
                                    e.preventDefault();
                                }
                            }}
                        >
                            {observation.author}
                        </a>
                        {showPhoto && observation.photoLicenseCode && ` · ${formatLicense(observation.photoLicenseCode)}`}
                    </p>
                </div>
            </div>
        </div>
    );
}

// Draws observations, grouping nearby ones into clusters until the map is zoomed in.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
function ObservationLayer({ points, species }: { points: CottontailRow[]; species: string[] }) {
    const map = useMap();
    // The single observation under the mouse (or whose tooltip is), and where its dot is.
    const [hovered, setHovered] = useState<{ observation: CottontailRow; position: google.maps.LatLng } | null>(null);

    // Leaving a dot closes its tooltip after a short delay, which entering the tooltip cancels.
    const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
    const scheduleHide = useCallback(() => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setHovered(null), TOOLTIP_HIDE_DELAY);
    }, []);
    const hideNow = useCallback(() => {
        clearTimeout(hideTimer.current);
        setHovered(null);
    }, []);
    useEffect(() => cancelHide, [cancelHide]);

    const byId = useMemo(() => new Map(points.map((d) => [d.occurrenceID, d])), [points]);

    // One cluster index per species, so a cluster keeps its species' color and the
    // rare species isn't swallowed by clusters of the common one.
    const indexes = useMemo(
        () => new Map(species.map((sp) => [
            sp,
            new Supercluster<PointProps, BadgeFlags>({
                radius: 60,
                maxZoom: CLUSTER_MAX_ZOOM,
                // A cluster gets a badge if any observation in it would.
                map: (p) => ({ hasPhoto: p.hasPhoto, hasJuvenile: p.hasJuvenile }),
                reduce: (acc, p) => {
                    acc.hasPhoto ||= p.hasPhoto;
                    acc.hasJuvenile ||= p.hasJuvenile;
                }
            }).load(
                points.filter((d) => d.species === sp).map((d) => ({
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [d.decimalLongitude, d.decimalLatitude] },
                    properties: {
                        occurrenceID: d.occurrenceID,
                        species: d.species,
                        hasPhoto: hasLivingPhoto(d),
                        hasJuvenile: d.lifeStage === JUVENILE
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
            // Doubled so each dot or cluster's badges can sit one step above it.
            const zIndex = 2 * (points.length - (counts.get(sp) ?? 0));
            const count = feature.getProperty("point_count") as number | undefined;

            const badge = feature.getProperty("badge") as BadgeKind | undefined;
            if (badge) {
                const radius = count ? clusterRadius(count) : POINT_RADIUS;
                return { icon: badgeIcon(badge, radius), cursor: count ? "pointer" : undefined, zIndex: zIndex + 1 };
            }

            if (count) {
                return {
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: clusterRadius(count),
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
                    scale: POINT_RADIUS,
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
                    const properties = { ...f.properties, species: sp };
                    next.set(key, { type: "Feature", id: key, geometry: f.geometry, properties });

                    // Each badge is its own feature at the same spot. It carries the same
                    // properties, so hovering or clicking it acts on its dot or cluster.
                    const badges: BadgeKind[] = [];
                    if (f.properties.hasPhoto) badges.push("photo");
                    if (f.properties.hasJuvenile) badges.push("juvenile");
                    for (const badge of badges) {
                        next.set(`${key}:${badge}`, {
                            type: "Feature",
                            id: `${key}:${badge}`,
                            geometry: f.geometry,
                            properties: { ...properties, badge }
                        });
                    }
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
            cancelHide();
            setHovered({ observation, position: geometry.get() });
        });
        const outListener = layer.addListener("mouseout", scheduleHide);
        // Zooming can swap the hovered dot into a cluster without a mouseout, so close the tooltip.
        const zoomListener = map.addListener("zoom_changed", hideNow);

        return () => {
            idleListener.remove();
            clickListener.remove();
            overListener.remove();
            outListener.remove();
            zoomListener.remove();
            layer.setMap(null);
            hideNow();
        };
    }, [map, points, species, indexes, byId, cancelHide, scheduleHide, hideNow]);

    return hovered && (
        <MapOverlay position={hovered.position}>
            <ObservationTooltip
                // A fresh tooltip per observation, so it starts its photo search over.
                key={hovered.observation.occurrenceID}
                observation={hovered.observation}
                onMouseEnter={cancelHide}
                onMouseLeave={scheduleHide}
            />
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
                {mode === "points" ? (
                    <>
                        {species.map((sp) => (
                            <span key={sp} className="flex items-center gap-1">
                                <span className="inline-block w-3 h-3 rounded-full" style={{ background: speciesColor(sp) }} />
                                <i>{sp}</i>
                            </span>
                        ))}
                        <span className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                            <img src={BADGE_URLS.photo} alt="" className="h-[13px] w-[13px]" />
                            has a photo (hover a single dot to see it)
                        </span>
                        <span className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                            <img src={BADGE_URLS.juvenile} alt="" className="h-[13px] w-[13px]" />
                            juvenile
                        </span>
                    </>
                ) : heatmapSpecies.length > 0 && (
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
