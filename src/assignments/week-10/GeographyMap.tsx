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

const MAPS_API_KEY: string = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

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
const photoUrl = (photoID: number, extension: string, size: "medium" | "original" = "medium") =>
    `https://inaturalist-open-data.s3.amazonaws.com/photos/${photoID}/${size}.${extension}`;

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

// An observation's photo, with the file extension that was found to work.
interface ObservationPhoto {
    observation: CottontailRow;
    extension: string;
}

// The full-resolution photo over the whole page. Closes on Escape, the close button, or a click
// outside the photo.
function PhotoModal({ photo, onClose }: { photo: ObservationPhoto; onClose: () => void }) {
    const { observation, extension } = photo;
    const medium = photoUrl(observation.photoID, extension);
    const original = photoUrl(observation.photoID, extension, "original");
    // Originals can be several megabytes, so the (already loaded) medium size stands in until
    // the original arrives. If the original fails, the medium size stays.
    const [src, setSrc] = useState(medium);
    const closeButton = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const image = new Image();
        image.onload = () => setSrc(original);
        image.src = original;
        return () => {
            image.onload = null;
        };
    }, [original]);

    useEffect(() => {
        closeButton.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            // The app also toggles its sidebar on Escape. Listening in the capture phase runs this
            // first, so stopping the event here keeps that from happening too.
            e.stopPropagation();
            onClose();
        };
        window.addEventListener("keydown", onKeyDown, { capture: true });
        return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    }, [onClose]);

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Photo of the observed ${observation.species}`}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-6"
            onClick={onClose}
        >
            <button
                ref={closeButton}
                type="button"
                aria-label="Close photo"
                className="absolute right-4 top-4 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-3xl leading-none text-white/80 hover:bg-white/10 hover:text-white"
                onClick={onClose}
            >
                ×
            </button>
            <img
                src={src}
                alt={`Photo of the observed ${observation.species}`}
                // Fills the available height, so the stand-in is the same size as the original.
                className="h-[calc(100vh-7rem)] max-w-full rounded-lg object-contain"
                onClick={(e) => e.stopPropagation()}
            />
            <p className="text-sm text-white/80" onClick={(e) => e.stopPropagation()}>
                <span className="italic">{observation.species}</span>
                {" · "}{observation.author}
                {observation.photoLicenseCode && ` · ${formatLicense(observation.photoLicenseCode)}`}
                {src === medium && " · loading full resolution…"}
            </p>
        </div>,
        document.body
    );
}

interface ObservationTooltipProps {
    observation: CottontailRow;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onOpenPhoto: (photo: ObservationPhoto) => void;
}

// The card shown next to a single observation while it's hovered.
function ObservationTooltip({ observation, onMouseEnter, onMouseLeave, onOpenPhoto }: ObservationTooltipProps) {
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
                    <button
                        type="button"
                        title="View full-resolution photo"
                        className="relative shrink-0 cursor-zoom-in rounded-xl"
                        onClick={() => onOpenPhoto({ observation, extension: PHOTO_EXTENSIONS[extensionIndex] })}
                    >
                        <img
                            src={photoUrl(observation.photoID, PHOTO_EXTENSIONS[extensionIndex])}
                            alt={`Photo of the observed ${observation.species}`}
                            className="h-32 w-32 rounded-xl bg-gray-100 object-cover dark:bg-gray-700"
                            // Wrong extension: try the next one, and leave the image out once they run out.
                            onError={() => setExtensionIndex((i) => i + 1)}
                        />
                    </button>
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

// Opacity of the dots and clusters that don't match the filter being previewed.
const FADED_OPACITY = 0.15;

interface ObservationLayerProps {
    points: CottontailRow[];
    // Every species in the data, most observed first. Later species are drawn on top, so the
    // rarer ones aren't buried under the common one.
    species: string[];
    // A filter whose legend entry is hovered: what doesn't match it is faded.
    preview: Filter | null;
}

// Draws observations, grouping nearby ones into clusters until the map is zoomed in.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
//
// Each marker on a Google Maps Data layer is slow to create (around half a millisecond), so the
// layer is made once and kept: panning, zooming, filtering and the time range all update it by
// adding and removing only the markers that changed.
function ObservationLayer({ points, species, preview }: ObservationLayerProps) {
    const map = useMap();

    // Read by the layer's style function, so changing the preview only restyles the
    // features instead of rebuilding the layer.
    const previewRef = useRef(preview);
    const restyle = useRef<(() => void) | null>(null);
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

    // The photo open in the full-resolution viewer. Kept here rather than in the tooltip, so it
    // stays open after the tooltip closes.
    const [openPhoto, setOpenPhoto] = useState<ObservationPhoto | null>(null);
    const closePhoto = useCallback(() => setOpenPhoto(null), []);
    const showPhoto = useCallback((photo: ObservationPhoto) => {
        // The viewer covers the map, so the tooltip has nothing to point at.
        hideNow();
        setOpenPhoto(photo);
    }, [hideNow]);

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

    // The layer reads the current data through these, so new data doesn't mean a new layer.
    const indexesRef = useRef(indexes);
    const byIdRef = useRef(byId);
    // Brings the layer up to date with the view; `force` also redoes it when the view hasn't moved.
    const sync = useRef<((force: boolean) => void) | null>(null);

    useEffect(() => {
        if (!map) return;

        // Doubled so each dot or cluster's badges can sit one step above it.
        const zIndexes = new Map(species.map((sp, i) => [sp, 2 * i]));

        const layer = new google.maps.Data({ map });
        const style = (feature: google.maps.Data.Feature): google.maps.Data.StyleOptions => {
            const sp = feature.getProperty("species") as string;
            const zIndex = zIndexes.get(sp) ?? 0;
            const count = feature.getProperty("point_count") as number | undefined;
            // Badges carry their dot or cluster's properties, so they fade along with it.
            const opacity = previewRef.current && !featureMatches(feature, previewRef.current) ? FADED_OPACITY : 1;

            const badge = feature.getProperty("badge") as BadgeKind | undefined;
            if (badge) {
                const radius = count ? clusterRadius(count) : POINT_RADIUS;
                return { icon: badgeIcon(badge, radius), cursor: count ? "pointer" : undefined, zIndex: zIndex + 1, opacity };
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
                    opacity,
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
                zIndex,
                opacity
            };
        };
        layer.setStyle(style);
        // A new function each time, so the layer re-runs it on every feature.
        restyle.current = () => layer.setStyle((feature) => style(feature));

        // The area and zoom the layer currently has features for.
        let loaded: { zoom: number; bbox: [number, number, number, number] } | null = null;
        // Feature id -> Supercluster cluster id, for every cluster and its badges. Kept out of the
        // features' properties because a cluster kept across a data change gets a new cluster id.
        let clusterIds = new Map<string, number>();

        sync.current = (force) => {
            const bounds = map.getBounds();
            const rawZoom = map.getZoom();
            if (!bounds || rawZoom === undefined) return;

            const zoom = Math.round(rawZoom);
            const sw = bounds.getSouthWest();
            const ne = bounds.getNorthEast();

            // Small pans that stay inside the already-loaded area need no update at all.
            if (
                !force && loaded && loaded.zoom === zoom &&
                sw.lng() >= loaded.bbox[0] && sw.lat() >= loaded.bbox[1] &&
                ne.lng() <= loaded.bbox[2] && ne.lat() <= loaded.bbox[3]
            ) return;

            // Load a quarter screen of margin on every side so short pans are covered. Every
            // loaded marker costs time to create, so more margin makes each update slower.
            const dLng = (ne.lng() - sw.lng()) / 4;
            const dLat = (ne.lat() - sw.lat()) / 4;
            const bbox: [number, number, number, number] = [
                Math.max(-180, sw.lng() - dLng),
                Math.max(-90, sw.lat() - dLat),
                Math.min(180, ne.lng() + dLng),
                Math.min(90, ne.lat() + dLat)
            ];

            // Give every cluster and point an id that stays the same while it looks the same, so
            // it's kept rather than recreated. Points have their observation id. A cluster is
            // identified by what's drawn: its species, size, position and badges. (Supercluster's
            // own cluster ids can be reused for a different cluster once the data changes.)
            const next = new Map<string, GeoJSON.Feature>();
            const nextClusterIds = new Map<string, number>();
            for (const [sp, index] of indexesRef.current) {
                for (const f of index.getClusters(bbox, zoom)) {
                    const p = f.properties;
                    let key: string;
                    if ("cluster_id" in p) {
                        const [lng, lat] = f.geometry.coordinates;
                        key = `${sp}:cluster:${p.point_count}:${lng},${lat}:${p.hasPhoto ? "p" : ""}${p.hasJuvenile ? "j" : ""}`;
                    } else {
                        key = `${sp}:point:${p.occurrenceID}`;
                    }
                    const properties = { ...p, species: sp };
                    next.set(key, { type: "Feature", id: key, geometry: f.geometry, properties });

                    // Each badge is its own feature at the same spot. It carries the same
                    // properties, so hovering or clicking it acts on its dot or cluster.
                    const badges: BadgeKind[] = [];
                    if (p.hasPhoto) badges.push("photo");
                    if (p.hasJuvenile) badges.push("juvenile");
                    for (const badge of badges) {
                        next.set(`${key}:${badge}`, {
                            type: "Feature",
                            id: `${key}:${badge}`,
                            geometry: f.geometry,
                            properties: { ...properties, badge }
                        });
                    }

                    if ("cluster_id" in p) {
                        for (const id of [key, ...badges.map((b) => `${key}:${b}`)]) nextClusterIds.set(id, p.cluster_id);
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
            clusterIds = nextClusterIds;
        };

        const idleListener = map.addListener("idle", () => sync.current?.(false));
        sync.current(true);

        // Clicking a cluster zooms in just far enough to split it apart.
        const clickListener = layer.addListener("click", (e: google.maps.Data.MouseEvent) => {
            const clusterId = clusterIds.get(e.feature.getId() as string);
            const index = indexesRef.current.get(e.feature.getProperty("species") as string);
            if (clusterId === undefined || !index || !e.latLng) return;

            map.setZoom(index.getClusterExpansionZoom(clusterId));
            map.panTo(e.latLng);
        });

        // Hovering a single observation (not a cluster) shows its tooltip.
        const overListener = layer.addListener("mouseover", (e: google.maps.Data.MouseEvent) => {
            if (clusterIds.has(e.feature.getId() as string)) return;
            const observation = byIdRef.current.get(e.feature.getProperty("occurrenceID") as number);
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
            restyle.current = null;
            sync.current = null;
            hideNow();
        };
    }, [map, species, cancelHide, scheduleHide, hideNow]);

    // New data (from filters or the time range) updates the existing layer in place.
    useEffect(() => {
        if (indexesRef.current === indexes) return;
        indexesRef.current = indexes;
        byIdRef.current = byId;
        // The hovered observation may have just been filtered out.
        hideNow();
        sync.current?.(true);
    }, [indexes, byId, hideNow]);

    useEffect(() => {
        previewRef.current = preview;
        restyle.current?.();
    }, [preview]);

    return (
        <>
            {hovered && (
                <MapOverlay position={hovered.position}>
                    <ObservationTooltip
                        // A fresh tooltip per observation, so it starts its photo search over.
                        key={hovered.observation.occurrenceID}
                        observation={hovered.observation}
                        onMouseEnter={cancelHide}
                        onMouseLeave={scheduleHide}
                        onOpenPhoto={showPhoto}
                    />
                </MapOverlay>
            )}
            {openPhoto && (
                <PhotoModal key={openPhoto.observation.occurrenceID} photo={openPhoto} onClose={closePhoto} />
            )}
        </>
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

// Characteristics an observation can be filtered on, matching the map's badges.
type Trait = "photo" | "juvenile";
const TRAITS: Record<Trait, { label: string; test: (d: CottontailRow) => boolean }> = {
    photo: { label: "has a photo", test: hasLivingPhoto },
    juvenile: { label: "juvenile", test: (d) => d.lifeStage === JUVENILE }
};

type Filter = { kind: "species"; species: string } | { kind: "trait"; trait: Trait };

const filterKey = (f: Filter) => (f.kind === "species" ? `species:${f.species}` : `trait:${f.trait}`);

// Species filters widen each other (any of the chosen species), while traits narrow
// (every chosen trait), so "floridanus + transitionalis + juvenile" means juveniles of either.
function matchesFilters(d: CottontailRow, filters: Filter[]) {
    const species = filters.filter((f) => f.kind === "species");
    if (species.length > 0 && !species.some((f) => f.species === d.species)) return false;
    return filters.every((f) => f.kind !== "trait" || TRAITS[f.trait].test(d));
}

// Whether a dot, cluster or badge on the map matches a filter. A cluster matches a trait if any
// observation in it has the trait, the same rule that gives it the trait's badge.
function featureMatches(feature: google.maps.Data.Feature, filter: Filter) {
    if (filter.kind === "species") return feature.getProperty("species") === filter.species;
    return Boolean(feature.getProperty(filter.trait === "photo" ? "hasPhoto" : "hasJuvenile"));
}

interface LegendToggleProps {
    pressed: boolean;
    onClick: () => void;
    // Hovering (or focusing) an entry previews its filter on the map.
    onPreview: (previewing: boolean) => void;
    children: ReactNode;
}

// Legend entries double as filter toggles; a pressed one is highlighted.
function LegendToggle({ pressed, onClick, onPreview, children }: LegendToggleProps) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            title={pressed ? "Remove this filter" : "Filter to this"}
            onMouseEnter={() => onPreview(true)}
            onMouseLeave={() => onPreview(false)}
            onFocus={() => onPreview(true)}
            onBlur={() => onPreview(false)}
            className={`-mx-1.5 flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 ${
                pressed
                    ? "bg-gray-200 ring-1 ring-gray-400 dark:bg-gray-700 dark:ring-gray-500"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

// The applied filters, each removable on its own.
function FilterChips({ filters, onRemove, onClear }: { filters: Filter[]; onRemove: (f: Filter) => void; onClear: () => void }) {
    return (
        <div className="flex min-h-7 flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-400">Filters:</span>
            {filters.length === 0 && (
                <span className="text-gray-500">none · click a legend entry to add one</span>
            )}
            {filters.map((f) => {
                const label = f.kind === "species" ? f.species : TRAITS[f.trait].label;
                return (
                    <span
                        key={filterKey(f)}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-100 py-0.5 pl-2.5 pr-1 dark:border-gray-600 dark:bg-gray-800"
                    >
                        {f.kind === "species" ? (
                            <>
                                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: speciesColor(f.species) }} />
                                <i>{label}</i>
                            </>
                        ) : (
                            <>
                                <img src={BADGE_URLS[f.trait]} alt="" className="h-[13px] w-[13px]" />
                                {label}
                            </>
                        )}
                        <button
                            type="button"
                            aria-label={`Remove filter: ${label}`}
                            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-base leading-none text-gray-500 hover:bg-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-600 dark:hover:text-gray-100"
                            onClick={() => onRemove(f)}
                        >
                            ×
                        </button>
                    </span>
                );
            })}
            {filters.length > 1 && (
                <button
                    type="button"
                    className="cursor-pointer text-gray-600 underline underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                    onClick={onClear}
                >
                    Clear all
                </button>
            )}
        </div>
    );
}

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
    // Most observed first, the order the points layer draws them in. Also from all observations,
    // so filtering doesn't reorder them (which would restyle every marker).
    const drawOrder = useMemo(() => {
        const counts = d3.rollup((data ?? []).filter(isMappable), (v) => v.length, (d) => d.species);
        return [...species].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    }, [data, species]);
    // In the order they were added, so new chips go on the end.
    const [filters, setFilters] = useState<Filter[]>([]);
    const isActive = (f: Filter) => filters.some((g) => filterKey(g) === filterKey(f));
    const removeFilter = (f: Filter) => setFilters((fs) => fs.filter((g) => filterKey(g) !== filterKey(f)));
    const toggleFilter = (f: Filter) => (isActive(f) ? removeFilter(f) : setFilters((fs) => [...fs, f]));

    // The filter whose legend entry is hovered or focused.
    const [preview, setPreview] = useState<Filter | null>(null);
    // Leaving only clears the preview if it's still this entry's, in case another entry was entered first.
    const previewFilter = (f: Filter) => (previewing: boolean) =>
        setPreview((p) => (previewing ? f : p && filterKey(p) === filterKey(f) ? null : p));

    const visiblePoints = useMemo(
        () => (filtered ?? []).filter((d) => isMappable(d) && matchesFilters(d, filters)),
        [filtered, filters]
    );

    // The heatmap mixes species colors by share, so observations not identified to a species
    // are left out of it rather than diluting the mix.
    const heatmapSpecies = useMemo(() => species.filter((sp) => !isGenusOnly(sp)), [species]);
    // Filters are only offered in points mode for now, so the heatmap ignores them. They're kept,
    // though, and apply again on switching back to points.
    const heatmapPoints = useMemo(
        () => (filtered ?? []).filter((d) => isMappable(d) && !isGenusOnly(d.species)),
        [filtered]
    );
    const shownCount = mode === "points" ? visiblePoints.length : heatmapPoints.length;
    // Only once the data has loaded, and only when filters are on, since that's what the warning offers to undo.
    const filteredToNothing = mode === "points" && data !== null && filters.length > 0 && shownCount === 0;

    const changeMode = (next: MapMode) => {
        // The hovered legend entry disappears without a mouseleave, so drop its preview here.
        setPreview(null);
        setMode(next);
    };

    return (
        <div className="flex flex-col w-full h-full gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>
                    Observations: {d3.format(",")(shownCount)}
                </span>
                {mode === "points" ? (
                    <>
                        {species.map((sp) => {
                            const f: Filter = { kind: "species", species: sp };
                            return (
                                <LegendToggle key={sp} pressed={isActive(f)} onClick={() => toggleFilter(f)} onPreview={previewFilter(f)}>
                                    <span className="inline-block w-3 h-3 rounded-full" style={{ background: speciesColor(sp) }} />
                                    <i>{sp}</i>
                                </LegendToggle>
                            );
                        })}
                        {(Object.keys(TRAITS) as Trait[]).map((trait) => {
                            const f: Filter = { kind: "trait", trait };
                            return (
                                <LegendToggle key={trait} pressed={isActive(f)} onClick={() => toggleFilter(f)} onPreview={previewFilter(f)}>
                                    <img src={BADGE_URLS[trait]} alt="" className="h-[13px] w-[13px]" />
                                    <span className="text-gray-600 dark:text-gray-400">
                                        {TRAITS[trait].label}
                                    </span>
                                </LegendToggle>
                            );
                        })}
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

            {mode === "points" && (
                <FilterChips filters={filters} onRemove={removeFilter} onClear={() => setFilters([])} />
            )}

            <MapSettings mode={mode} onModeChange={changeMode} timeSlider={timeSlider} />

            <div className="relative flex-1 min-h-0 overflow-hidden rounded">
                {filteredToNothing && (
                    // Floats over the top of the map; the map underneath stays usable.
                    <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
                        <div
                            role="status"
                            className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                        >
                            <span>
                                <span aria-hidden="true">⚠ </span>
                                No observations match {filters.length === 1 ? "this filter" : "this combination of filters"} in
                                the selected time range.
                            </span>
                            <button
                                type="button"
                                className="cursor-pointer font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-white"
                                onClick={() => setFilters((fs) => fs.slice(0, -1))}
                            >
                                Undo last filter
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-white"
                                onClick={() => setFilters([])}
                            >
                                Clear all
                            </button>
                        </div>
                    </div>
                )}
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
                            ? <ObservationLayer points={visiblePoints} species={drawOrder} preview={preview} />
                            : <DensityHeatmap points={heatmapPoints} species={heatmapSpecies} />}
                    </GoogleMap>
                </APIProvider>
            </div>
        </div>
    );
}
