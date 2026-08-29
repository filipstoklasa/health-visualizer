import type { WorkoutInRange } from '../types.ts';
import { getData } from '../state.ts';
import { asleepHours, series } from '../data.ts';
import { esc, fmt } from '../format.ts';
import { $ } from '../dom.ts';

const tile = (k: string, v: string, u: string) =>
  `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}<span class="u">${esc(u)}</span></div></div>`;

export function renderTiles(dates: string[], inRange: WorkoutInRange[]): void {
  const data = getData();
  const avg = (key: string) => {
    const s = series(data, key, dates).points;
    return s.length ? s.reduce((a, b) => a + b.v, 0) / s.length : null;
  };
  const nights = dates.map(d => data.sleep[d]).filter(Boolean);
  const sleepAvg = nights.length ? nights.reduce((a, s) => a + asleepHours(s!), 0) / nights.length : null;

  $('#tiles').innerHTML =
    tile('Steps / day', fmt(avg('StepCount'), 0), '')
    + tile('Distance / day', fmt(avg('DistanceWalkingRunning')), 'km')
    + tile('Active energy / day', fmt(avg('ActiveEnergyBurned'), 0), 'kcal')
    + tile('Resting heart rate', fmt(avg('RestingHeartRate'), 0), 'bpm')
    + tile('Sleep / night', fmt(sleepAvg, 1), 'h')
    + tile('Workouts', fmt(inRange.length, 0), '');
}
