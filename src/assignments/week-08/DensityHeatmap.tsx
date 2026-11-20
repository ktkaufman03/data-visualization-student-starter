import { useEffect } from 'react';
import * as d3 from 'd3';
import { useMap } from '@vis.gl/react-google-maps';
import type { CottontailRow } from './types';
import { speciesColor } from './species';

// Density is counted on a grid of CELL x CELL screen pixels, then spread out with a
// Gaussian of SIGMA cells.
const CELL = 4;
const SIGMA = 3;
// Highest and lowest opacity, so dense areas don't hide the map and single sightings still show.
const MAX_ALPHA = 0.85;
const MIN_ALPHA = 0.25;
// Below this many "observations nearby" a cell fades out, reaching nothing at a quarter of one.
const FADE_START = 1;
const FADE_END = 0.25;

// Gaussian weights out to 4 sigma; past that they're too small to matter even under
// thousands of stacked observations, so the heatmap's edges stay round.
// Unnormalized (peak of 1), so a blurred cell reads as roughly "observations nearby".
const KERNEL = d3.range(-4 * SIGMA, 4 * SIGMA + 1).map((x) => Math.exp(-(x * x) / (2 * SIGMA * SIGMA)));

// Separable Gaussian blur of a width x height grid, in place.
function gaussianBlur(grid: Float32Array, width: number, height: number) {
    const r = (KERNEL.length - 1) / 2;
    const tmp = new Float32Array(grid.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = grid[y * width + x];
            if (!v) continue;
            for (let k = -r; k <= r; k++) {
                const xx = x + k;
                if (xx >= 0 && xx < width) tmp[y * width + xx] += v * KERNEL[k + r];
            }
        }
    }
    grid.fill(0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = tmp[y * width + x];
            if (!v) continue;
            for (let k = -r; k <= r; k++) {
                const yy = y + k;
                if (yy >= 0 && yy < height) grid[yy * width + x] += v * KERNEL[k + r];
            }
        }
    }
}

// Draws a density heatmap of the observations on a canvas over the map. Opacity shows how
// many observations there are; color is the species colors mixed by each species' share.
// Must be rendered inside <GoogleMap> so useMap() finds the map.
export function DensityHeatmap({ points, species }: { points: CottontailRow[]; species: string[] }) {
    const map = useMap();

    useEffect(() => {
        if (!map) return;

        const canvas = document.createElement("canvas");
        canvas.style.position = "absolute";
        canvas.style.pointerEvents = "none";

        // Species colors in Lab, so mixing them gives perceptually even in-between colors.
        const labs = species.map((sp) => d3.lab(speciesColor(sp, species)));
        const bySpecies = species.map((sp) => points
            .filter((d) => d.species === sp)
            .map((d) => new google.maps.LatLng(d.decimalLatitude, d.decimalLongitude)));

        const overlay = new google.maps.OverlayView();

        const render = () => {
            const projection = overlay.getProjection();
            const bounds = map.getBounds();
            if (!projection || !bounds) return;

            // Cover the view plus half a screen on each side, so short pans don't reveal an
            // empty edge before the next redraw.
            const { clientWidth: w, clientHeight: h } = map.getDiv();
            const nw = projection.fromLatLngToDivPixel(
                new google.maps.LatLng(bounds.getNorthEast().lat(), bounds.getSouthWest().lng())
            );
            if (!nw) return;
            const x0 = nw.x - w / 2;
            const y0 = nw.y - h / 2;
            const gw = Math.ceil((2 * w) / CELL);
            const gh = Math.ceil((2 * h) / CELL);

            // One grid of counts per species, each spread over its neighborhood.
            const grids = bySpecies.map((latLngs) => {
                const grid = new Float32Array(gw * gh);
                for (const ll of latLngs) {
                    const p = projection.fromLatLngToDivPixel(ll);
                    if (!p) continue;
                    const gx = Math.floor((p.x - x0) / CELL);
                    const gy = Math.floor((p.y - y0) / CELL);
                    if (gx >= 0 && gx < gw && gy >= 0 && gy < gh) grid[gy * gw + gx]++;
                }
                gaussianBlur(grid, gw, gh);
                return grid;
            });

            const total = new Float32Array(gw * gh);
            for (const grid of grids) {
                for (let i = 0; i < total.length; i++) total[i] += grid[i];
            }
            const max = d3.max(total) ?? 0;
            const scale = max > 1 ? 1 / Math.log(max) : 0;

            const img = new ImageData(gw, gh);
            for (let i = 0; i < total.length; i++) {
                const nearby = total[i];
                if (nearby < FADE_END) continue;
                // Log scale, so a single rare-species sighting still shows next to the thousands
                // of observations around Boston. One observation nearby maps to 0.
                const t = Math.max(0, Math.log(nearby) * scale);
                const fade = Math.min(1, (nearby - FADE_END) / (FADE_START - FADE_END));

                // Average the species colors, weighted by each species' share of this cell.
                let l = 0, a = 0, b = 0;
                for (let s = 0; s < grids.length; s++) {
                    const share = grids[s][i] / total[i];
                    l += labs[s].l * share;
                    a += labs[s].a * share;
                    b += labs[s].b * share;
                }
                const c = d3.lab(l, a, b).rgb();
                img.data[i * 4] = c.r;
                img.data[i * 4 + 1] = c.g;
                img.data[i * 4 + 2] = c.b;
                img.data[i * 4 + 3] = (MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * t) * fade * 255;
            }

            canvas.width = gw;
            canvas.height = gh;
            canvas.getContext("2d")!.putImageData(img, 0, 0);
            // The grid is drawn at 1/CELL size and stretched; the browser's smoothing hides the cells.
            canvas.style.left = `${x0}px`;
            canvas.style.top = `${y0}px`;
            canvas.style.width = `${gw * CELL}px`;
            canvas.style.height = `${gh * CELL}px`;
        };

        overlay.onAdd = () => overlay.getPanes()?.overlayLayer.appendChild(canvas);
        overlay.onRemove = () => canvas.remove();
        // Called by the map whenever the zoom or projection changes.
        overlay.draw = render;
        overlay.setMap(map);

        // Panning doesn't call draw(), so also redraw once the map settles.
        const idleListener = map.addListener("idle", render);

        return () => {
            idleListener.remove();
            overlay.setMap(null);
        };
    }, [map, points, species]);

    return null;
}
