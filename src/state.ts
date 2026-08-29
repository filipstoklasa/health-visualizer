import type { Aggregate } from './types.ts';

export interface ViewState {
  /** Days back from the last recorded day; 0 means everything. */
  days: number;
  metric: string;
  /** Index into Aggregate.workouts, or null for "all". */
  sel: number | null;
}

export type StateKey = keyof ViewState;

const url = new URLSearchParams(location.search);

export const state: ViewState = {
  days: Number(url.get('r')) || (url.has('r') ? 0 : 365),
  metric: url.get('m') || 'StepCount',
  sel: url.has('w') ? Number(url.get('w')) : null,
};

const syncUrl = () =>
  history.replaceState(null, '', `?r=${state.days}&m=${state.metric}`
    + (state.sel == null ? '' : `&w=${state.sel}`));

let data: Aggregate | null = null;

export function setData(d: Aggregate): void { data = d; }

export function getData(): Aggregate {
  if (!data) throw new Error('getData() before setData()');
  return data;
}

const listeners: { keys: readonly StateKey[]; run: () => void }[] = [];

/**
 * Re-run `run` only when one of `keys` actually changes. This is what keeps a
 * workout click from rebuilding both charts and every table row.
 */
export function subscribe(keys: readonly StateKey[], run: () => void): void {
  listeners.push({ keys, run });
}

export function setState(patch: Partial<ViewState>): void {
  const changed = (Object.keys(patch) as StateKey[]).filter(k => state[k] !== patch[k]);
  if (!changed.length) return;
  Object.assign(state, patch);
  syncUrl();
  for (const l of listeners) if (l.keys.some(k => changed.includes(k))) l.run();
}
