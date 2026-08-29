import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Aggregate, LatLon, Route, WorkoutInRange } from './types.ts';
import { esc, fmt, label } from './format.ts';
import { $ } from './dom.ts';

let map: L.Map | null = null;
let routeLayer: L.LayerGroup;
let typeColor: Record<string, string> = {};
let visible: Route[] = [];
let away = 0;

/** Colour follows the activity, not its rank in the current filter. */
export function assignColors(data: Aggregate): void {
  const freq: Record<string, number> = {};
  for (const r of data.routes) freq[r.type] = (freq[r.type] ?? 0) + 1;
  typeColor = {};
  Object.keys(freq).sort((a, b) => (freq[b] as number) - (freq[a] as number)).forEach((t, i) => {
    typeColor[t] = getComputedStyle(document.documentElement)
      .getPropertyValue(`--series-${(i % 5) + 1}`).trim();
  });
}

function initMap(): void {
  if (map) return;
  map = L.map('map', { scrollWheelZoom: false }).setView([50.09, 14.45], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  map.on('click', () => fitAll());
}

const mid = (r: Route): LatLon => r.pts[r.pts.length >> 1] as LatLon;

/**
 * Fit where the routes actually are: a couple of trips abroad would otherwise
 * zoom the map out to all of Europe, where every track is sub-pixel.
 */
function homeBounds(rs: Route[]): L.LatLngBounds {
  const q = (a: number[], p: number) =>
    a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] as number;
  const lat = rs.map(r => mid(r)[0]), lon = rs.map(r => mid(r)[1]);
  const [s, n, w, e] = [q(lat, 0.1), q(lat, 0.9), q(lon, 0.1), q(lon, 0.9)];
  const home = rs.filter(r => { const [a, o] = mid(r); return a >= s && a <= n && o >= w && o <= e; });
  away = rs.length - home.length;
  return L.latLngBounds((home.length ? home : rs).flatMap(r => r.pts)).pad(0.08);
}

const fitAll = () => { if (visible.length && map) map.fitBounds(homeBounds(visible)); };

export function renderMap(data: Aggregate, dates: string[], picked: WorkoutInRange | null): void {
  const from = dates[0] ?? '', to = dates[dates.length - 1] ?? '';
  visible = picked
    ? (picked.route ? [picked.route] : [])
    : data.routes.filter(r => r.start.slice(0, 10) >= from && r.start.slice(0, 10) <= to);
  const km = visible.reduce((a, r) => a + r.km, 0);

  initMap();
  $('#mapNote').textContent = picked
    ? (visible.length
      ? `${label(picked.type)} on ${picked.start.replace('T', ' ')} — ${fmt(picked.km ?? km)} km.`
        + ' Press Escape or clear the selection to see every route again.'
      : 'No GPS route was recorded for this workout. Press Escape or clear the selection to see every route again.')
    : visible.length
      ? `${visible.length} GPS route${visible.length === 1 ? '' : 's'} in range, ${fmt(km)} km total.`
        + ' Click a track for details, the map background to zoom back out.'
      : 'No GPS routes in this range — the watch recorded them from 2025 on.';
  $('#mapLegend').innerHTML = [...new Set(visible.map(r => r.type))]
    .sort((a, b) => Object.keys(typeColor).indexOf(a) - Object.keys(typeColor).indexOf(b))
    .map(t => `<span><i class="sw" style="background:${esc(typeColor[t])}"></i>${esc(label(t))}</span>`).join('');

  routeLayer.clearLayers();
  for (const r of visible) {
    L.polyline(r.pts, { color: typeColor[r.type], weight: 3, opacity: 0.85 })
      .bindPopup(`<b>${esc(label(r.type))}</b><br>${esc(r.start.replace('T', ' '))}<br>${fmt(r.km)} km`)
      .on('mouseover', e => (e.target as L.Polyline).setStyle({ weight: 6 }))
      .on('mouseout', e => (e.target as L.Polyline).setStyle({ weight: 3 }))
      .addTo(routeLayer);
  }
  if (visible.length && map) {
    map.invalidateSize();
    if (picked) map.fitBounds(L.latLngBounds((visible[0] as Route).pts).pad(0.15));
    else {
      fitAll();
      if (away) {
        $('#mapNote').textContent += ` ${away} route${away === 1 ? ' is' : 's are'} outside this view`
          + ` — zoom out to find ${away === 1 ? 'it' : 'them'}.`;
      }
    }
  }
}
