import type { WorkoutInRange } from '../types.ts';
import { bestRuns } from '../data.ts';
import { esc, sessionLine } from '../format.ts';
import { $ } from '../dom.ts';

export function renderBests(inRange: WorkoutInRange[]): void {
  const bests = bestRuns(inRange);
  $('#bestNote').textContent = bests.length
    ? 'Your record runs in this range. Pick one to put it on the map.'
    : `No runs in this range${inRange.length ? ' — the workouts here are other activities.' : '.'}`;
  $('#bests').innerHTML = bests.map(([title, w, value]) => {
    const [v, u] = value(w);
    return `<button class="tile best" data-i="${w.i}" aria-selected="false">`
      + `<div class="k">${esc(title)}</div><div class="v">${esc(v)}<span class="u">${esc(u)}</span></div>`
      + `<div class="sub"><span class="when">${esc(w.start.replace('T', ' '))}</span><br>${esc(sessionLine(w))}</div></button>`;
  }).join('');
}
