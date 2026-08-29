import type { WorkoutInRange } from '../types.ts';
import { esc, fmt, label } from '../format.ts';
import { $ } from '../dom.ts';

export function renderTable(inRange: WorkoutInRange[]): void {
  $('#workouts').innerHTML =
    '<thead><tr><th>Date</th><th>Type</th><th>Duration</th><th>Distance</th><th>Energy</th><th>Avg HR</th></tr></thead><tbody>'
    + inRange.slice().reverse().map(w =>
      `<tr data-i="${w.i}" aria-selected="false">`
      + `<td>${esc(w.start.replace('T', ' '))}</td><td>${esc(label(w.type))}</td>`
      + `<td>${fmt(w.min, 0)} min</td>`
      + `<td>${w.km == null ? '–' : fmt(w.km) + ' km'}</td>`
      + `<td>${w.kcal == null ? '–' : fmt(w.kcal, 0) + ' kcal'}</td>`
      + `<td>${w.hr == null ? '–' : fmt(w.hr, 0) + ' bpm'}</td></tr>`).join('')
    + '</tbody>';
}

/**
 * Selection is a DOM attribute flip, not a re-render: picking a workout must
 * not rebuild thousands of table rows and both charts.
 */
export function applySelection(sel: number | null, count: number): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i]')) {
    const mine = Number(el.dataset.i) === sel;
    el.setAttribute('aria-selected', String(mine));
    if (el.tagName === 'TR') el.title = mine ? 'Back to every workout' : 'Show only this workout';
  }
  $('#workoutNote').innerHTML = `${count} workout${count === 1 ? '' : 's'} in range — `
    + (sel == null
      ? 'pick a row to put just that one on the map.'
      : 'the highlighted one is on the map. <button class="range" id="showAll">Clear selection</button>');
}
