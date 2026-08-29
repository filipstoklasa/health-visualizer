import type { Aggregate, SleepNight, WorkoutFigures, WorkoutInRange } from './types.ts';
import { dayMs, fmt, iso, paceText } from './format.ts';

export type Bucket = 'day' | 'week' | 'month';

export function rangeDates(data: Aggregate, days: number): string[] {
  const all = Object.keys(data.days);
  const last = all[all.length - 1];
  if (!days || last === undefined) return all;
  const cut = iso(new Date(last + 'T00:00:00Z').getTime() - days * dayMs);
  return all.filter(d => d >= cut);
}

// Buckets keep the chart readable: at most ~370 marks.
export const bucketOf = (n: number): Bucket => (n <= 370 ? 'day' : n <= 1100 ? 'week' : 'month');

export function bucketKey(date: string, mode: Bucket): string {
  if (mode === 'day') return date;
  if (mode === 'month') return date.slice(0, 7);
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // ISO week start (Mon)
  return iso(t);
}

export interface MetricPoint { k: string; d: string; v: number; lo: number; hi: number }
export interface MetricSeries { mode: Bucket; isSum: boolean; points: MetricPoint[] }

/** Value per day, averaged inside each bucket -> units stay comparable across ranges. */
export function series(data: Aggregate, metric: string, dates: string[]): MetricSeries {
  const mode = bucketOf(dates.length), isSum = data.sumTypes.includes(metric);
  const acc = new Map<string, { k: string; s: number; n: number; lo: number; hi: number; first: string }>();
  for (const d of dates) {
    const raw = data.days[d]?.[metric];
    if (raw == null) continue;
    const [v, lo, hi] = Array.isArray(raw) ? raw : [raw, raw, raw];
    const k = bucketKey(d, mode);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { k, s: 0, n: 0, lo, hi, first: d }));
    a.s += v; a.n++;
    if (lo < a.lo) a.lo = lo;
    if (hi > a.hi) a.hi = hi;
  }
  return {
    mode, isSum,
    points: [...acc.values()].map(a => ({ k: a.k, d: a.first, v: a.s / a.n, lo: a.lo, hi: a.hi })),
  };
}

export const STAGES = ['deep', 'core', 'rem', 'awake', 'inBed'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_NAMES: Record<Stage, string> = {
  deep: 'Deep', core: 'Core', rem: 'REM', awake: 'Awake', inBed: 'In bed (unstaged)',
};

/**
 * Older iPhone-only nights record just "in bed"; keep them as their own series
 * rather than pretending they were staged sleep.
 */
export function night(s: SleepNight): Record<Stage, number> {
  const staged: Record<Stage, number> = {
    deep: s.deep || 0, core: (s.core || 0) + (s.asleep || 0), rem: s.rem || 0, awake: s.awake || 0, inBed: 0,
  };
  if (!(staged.deep || staged.core || staged.rem)) { staged.inBed = s.inBed || 0; staged.awake = 0; }
  return staged;
}

export const asleepHours = (s: SleepNight): number => {
  const n = night(s);
  return n.deep + n.core + n.rem + n.inBed;
};

export interface SleepPoint { k: string; d: string; parts: number[] }
export interface SleepSeries { mode: Bucket; stages: readonly Stage[]; points: SleepPoint[] }

export function sleepSeries(data: Aggregate, dates: string[]): SleepSeries {
  const mode = bucketOf(dates.length);
  const acc = new Map<string, { k: string; d: string; n: number; parts: number[] }>();
  for (const d of dates) {
    const s = data.sleep[d];
    if (!s || !asleepHours(s)) continue;
    const k = bucketKey(d, mode), n = night(s);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { k, d, n: 0, parts: STAGES.map(() => 0) }));
    a.n++;
    STAGES.forEach((st, i) => { a!.parts[i] = (a!.parts[i] ?? 0) + n[st]; });
  }
  return {
    mode, stages: STAGES,
    points: [...acc.values()].map(a => ({ k: a.k, d: a.d, parts: a.parts.map(v => v / a.n) })),
  };
}

const MIN_PACE_KM = 2;   // below this a warm-up sprint would win every time

export type BestRun = [title: string, workout: WorkoutInRange, value: (w: WorkoutFigures) => [string, string]];

/** The record-holding runs in a set of workouts. */
export function bestRuns(workouts: WorkoutInRange[]): BestRun[] {
  const runs = workouts.filter(w => w.type === 'Running');
  const top = (score: (w: WorkoutInRange) => number, ok: (w: WorkoutInRange) => boolean = () => true) => {
    let best: { w: WorkoutInRange; v: number } | null = null;
    for (const w of runs) {
      if (!ok(w)) continue;
      const v = score(w);
      if (!Number.isFinite(v)) continue;
      if (!best || v > best.v) best = { w, v };
    }
    return best?.w ?? null;
  };
  const candidates: [string, WorkoutInRange | null, (w: WorkoutFigures) => [string, string]][] = [
    ['Longest run', top(w => w.km!), w => [fmt(w.km), 'km']],
    ['Fastest pace', top(w => -(w.min! / w.km!), w => w.km != null && w.km >= MIN_PACE_KM && w.min != null && w.min > 0),
      w => [paceText(w)!.split(' ')[0] as string, '/km']],
    ['Longest time', top(w => w.min!), w => [fmt(w.min, 0), 'min']],
    ['Most energy', top(w => w.kcal!), w => [fmt(w.kcal, 0), 'kcal']],
  ];
  return candidates.filter((c): c is BestRun => c[1] !== null);
}

/** Workouts starting inside the range, each carrying its index and route. */
export function workoutsInRange(data: Aggregate, dates: string[], routeAt: Map<string, number>): WorkoutInRange[] {
  const from = dates[0] ?? '';
  return data.workouts
    .map((w, i) => ({ ...w, i, route: routeAt.has(w.start) ? data.routes[routeAt.get(w.start)!]! : null }))
    .filter(w => w.start.slice(0, 10) >= from);
}

/** First route recorded at each workout start time. */
export function routeIndex(data: Aggregate): Map<string, number> {
  const at = new Map<string, number>();
  data.routes.forEach((r, i) => { if (!at.has(r.start)) at.set(r.start, i); });
  return at;
}
