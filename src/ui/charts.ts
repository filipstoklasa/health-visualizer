import { getData, state } from '../state.ts';
import { STAGE_NAMES, series, sleepSeries } from '../data.ts';
import { draw, xLabel } from '../chart.ts';
import { NBSP, esc, fmt, label, unit } from '../format.ts';
import { $ } from '../dom.ts';

const bucketWord = { day: 'day', week: 'week (avg/day)', month: 'month (avg/day)' } as const;

export function renderMetricChart(dates: string[]): void {
  const data = getData(), m = state.metric, u = unit(data, m);
  const s = series(data, m, dates);

  $('#metricNote').textContent = `${label(m)}${u ? ' (' + u + ')' : ''} — one mark per ${bucketWord[s.mode]}`
    + (s.isSum ? ', daily total.' : ', daily average with the day’s min–max range.');
  $('#metricLegend').innerHTML = s.isSum
    ? `<span><i class="sw" style="background:var(--series-1)"></i>${esc(label(m))}</span>`
    : '<span><i class="sw" style="background:var(--series-1)"></i>Average</span>'
      + '<span><i class="sw" style="background:var(--band);outline:1px solid var(--line)"></i>Min–max</span>';

  draw($('#metricChart'), s.points, {
    mode: s.mode,
    aria: label(m) + ' over time',
    max: d => (s.isSum ? d.v : d.hi),
    bars: s.isSum,
    val: d => d.v,
    band: !s.isSum,
    line: s.isSum ? null : d => d.v,
    tip: d => `${esc(xLabel(d.k, s.mode))}<br><b>${fmt(d.v)}</b>${NBSP}${esc(u)}`
      + (s.isSum ? '' : `<br><span style="color:var(--text-muted)">min ${fmt(d.lo)} · max ${fmt(d.hi)}</span>`),
  });
}

export function renderSleepChart(dates: string[]): void {
  const data = getData();
  const sl = sleepSeries(data, dates);
  const lastNight = Object.keys(data.sleep).at(-1);

  $('#sleepLegend').innerHTML = !sl.points.length ? '' : sl.stages
    .map((st, i) => `<span><i class="sw" style="background:var(--series-${i + 1})"></i>${STAGE_NAMES[st]}</span>`)
    .join('');
  $('#sleepNote').textContent = sl.points.length
    ? `Hours per night by stage — one bar per ${bucketWord[sl.mode]}.`
      + ' Periods with no records are skipped, not left blank.'
    : `No sleep records in this range — the last one is ${lastNight}.`;

  draw($('#sleepChart'), sl.points, {
    mode: sl.mode,
    aria: 'Sleep hours by stage',
    bars: true,
    stacked: true,
    empty: 'Nothing to plot here — try a wider range.',
    max: d => d.parts.reduce((a, b) => a + b, 0),
    tip: d => `${esc(xLabel(d.k, sl.mode))}<br><b>${fmt(d.parts.reduce((a, b) => a + b, 0), 1)}</b>${NBSP}h total<br>`
      + `<span style="color:var(--text-muted)">`
      + `${sl.stages.map((st, i) => STAGE_NAMES[st] + ' ' + fmt(d.parts[i], 1)).join(' · ')}</span>`,
  });
}
