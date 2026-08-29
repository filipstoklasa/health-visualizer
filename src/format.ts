import type { Aggregate, WorkoutFigures } from './types.ts';

export const NBSP = ' ';

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

const LABELS: Record<string, string> = {  // only where the derived name is bad
  DistanceWalkingRunning: 'Walking + running distance',
  HeartRateVariabilitySDNN: 'Heart rate variability (SDNN)',
  AppleExerciseTime: 'Exercise time',
  AppleStandTime: 'Stand time',
  AppleWalkingSteadiness: 'Walking steadiness',
  AppleSleepingWristTemperature: 'Sleeping wrist temperature',
  AppleSleepingBreathingDisturbances: 'Sleeping breathing disturbances',
  BasalEnergyBurned: 'Resting energy',
  ActiveEnergyBurned: 'Active energy',
  SixMinuteWalkTestDistance: 'Six-minute walk test',
};

export const label = (k: string): string =>
  LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

const UNIT_FIX: Record<string, string> = {
  count: '', 'count/min': 'bpm', 'count/s': '/s', min: 'min', kcal: 'kcal', km: 'km', ms: 'ms', '%': '%',
};

export const unit = (data: Aggregate, k: string): string =>
  UNIT_FIX[data.units[k] ?? ''] ?? data.units[k] ?? '';

export const fmt = (v: number | null | undefined, digits?: number): string =>
  v == null ? '–'
    : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString()
      : v.toLocaleString(undefined, {
        maximumFractionDigits: digits ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2),
      });

export const dayMs = 864e5;
export const iso = (d: number | Date): string => new Date(d).toISOString().slice(0, 10);

/** Pace as m:ss per km — the number a runner actually reads. */
export function paceText(w: WorkoutFigures): string | null {
  if (!(w.km != null && w.km > 0) || !(w.min != null && w.min > 0)) return null;
  const perKm = w.min / w.km, mins = Math.floor(perKm);
  return `${mins}:${String(Math.round((perKm - mins) * 60)).padStart(2, '0')} /km`;
}

/** Everything known about one session, in one line. */
export function sessionLine(w: WorkoutFigures): string {
  const bits = [
    w.km == null ? null : fmt(w.km) + ' km',
    w.min == null ? null : fmt(w.min, 0) + ' min',
    paceText(w),
    w.kcal == null ? null : fmt(w.kcal, 0) + ' kcal',
    w.hr == null ? null : fmt(w.hr, 0) + ' bpm',
  ];
  return bits.filter(Boolean).join(' · ');
}
