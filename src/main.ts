import './styles.css';
import type { Aggregate, WorkoutInRange } from './types.ts';
import { getData, setData, setState, state, subscribe } from './state.ts';
import { rangeDates, routeIndex, workoutsInRange } from './data.ts';
import { assignColors, renderMap } from './map.ts';
import { renderTiles } from './ui/tiles.ts';
import { renderMetricChart, renderSleepChart } from './ui/charts.ts';
import { renderBests } from './ui/bests.ts';
import { applySelection, renderTable } from './ui/table.ts';
import { wireImport } from './ui/importer.ts';
import { idbGet } from './storage.ts';
import { esc, label } from './format.ts';
import { $ } from './dom.ts';

const RANGES: [string, number][] = [['30d', 30], ['90d', 90], ['1y', 365], ['3y', 1095], ['All', 0]];

let routeAt = new Map<string, number>();
let dates: string[] = [];
let inRange: WorkoutInRange[] = [];

/** Everything downstream of the range; recomputed only when the range changes. */
function recompute(): void {
  const data = getData();
  dates = rangeDates(data, state.days);
  inRange = workoutsInRange(data, dates, routeAt);
  if (state.sel != null && !inRange.some(w => w.i === state.sel)) state.sel = null;  // range no longer holds it
}

const picked = (): WorkoutInRange | null =>
  state.sel == null ? null : inRange.find(w => w.i === state.sel) ?? null;

function boot(d: Aggregate): void {
  setData(d);
  routeAt = routeIndex(d);
  assignColors(d);

  const days = Object.keys(d.days);
  $('#dash').hidden = false;
  $('#pick').hidden = false;
  $('#meta').textContent = `${days[0]} → ${days[days.length - 1]} · ${days.length.toLocaleString()} days · `
    + `${d.workouts.length} workouts · exported ${(d.meta.exported || '').slice(0, 10)}`;

  // range buttons
  $('#ranges').innerHTML = RANGES.map(([l, n]) =>
    `<button class="range" data-n="${n}" aria-pressed="${n === state.days}">${l}</button>`).join('');
  $('#ranges').onclick = e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.range');
    if (!b) return;
    for (const c of $('#ranges').children) c.setAttribute('aria-pressed', String(c === b));
    setState({ days: Number(b.dataset.n) });
  };

  // metric picker — only metrics this export actually has
  const present = new Set<string>();
  for (const row of Object.values(d.days)) for (const k of Object.keys(row)) present.add(k);
  if (!present.has(state.metric)) state.metric = 'StepCount';
  const metric = $<HTMLSelectElement>('#metric');
  metric.innerHTML = [...present].sort((a, b) => label(a).localeCompare(label(b)))
    .map(k => `<option value="${esc(k)}"${k === state.metric ? ' selected' : ''}>${esc(label(k))}</option>`).join('');
  metric.onchange = e => setState({ metric: (e.target as HTMLSelectElement).value });

  // selection
  const select = (i: number | null, scroll = false) => {
    setState({ sel: i });
    if (scroll) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const toggle = (e: Event, sel: string) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(sel);
    if (!el) return;
    const i = Number(el.dataset.i);
    select(i === state.sel ? null : i, i !== state.sel);
  };
  $('#workouts').onclick = e => toggle(e, 'tr[data-i]');
  $('#bests').onclick = e => toggle(e, '.best');
  $('#workoutNote').onclick = e => { if ((e.target as HTMLElement).id === 'showAll') select(null); };
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && state.sel != null) select(null); });

  // Each section listens for only the state it reads. Picking a workout below
  // therefore redraws the map and flips two attributes — nothing else.
  subscribe(['days'], () => {
    recompute();
    renderTiles(dates, inRange);
    renderSleepChart(dates);
    renderBests(inRange);
    renderTable(inRange);
  });
  subscribe(['days', 'metric'], () => renderMetricChart(dates));
  subscribe(['days', 'sel'], () => renderMap(getData(), dates, picked()));
  subscribe(['days', 'sel'], () => applySelection(state.sel, inRange.length));

  recompute();
  renderTiles(dates, inRange);
  renderMetricChart(dates);
  renderSleepChart(dates);
  renderBests(inRange);
  renderTable(inRange);
  renderMap(d, dates, picked());
  applySelection(state.sel, inRange.length);
}

wireImport(boot);

/** Stored import first, then a health.json served alongside, else ask for the zip. */
void (async () => {
  try {
    const saved = await idbGet('latest');
    if (saved) return boot(saved.data);
  } catch (e) {
    console.warn('IndexedDB unavailable:', (e as Error).message);
  }
  try {
    const r = await fetch('health.json');
    if (r.ok) return boot(await r.json() as Aggregate);
  } catch { /* not served alongside one — that is fine */ }
  $('#import').hidden = false;
  $('#meta').textContent = 'No data loaded yet.';
})();
