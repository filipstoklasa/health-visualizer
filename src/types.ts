/**
 * The aggregate contract: produced by ingest.ts in the browser and by
 * parse_health.py on the command line, consumed by everything in src/ui.
 * These two producers are cross-checked against each other in test.mjs.
 */

/** A summed metric is one number; an averaged one is [average, min, max]. */
export type DayValue = number | [avg: number, lo: number, hi: number];

export type DayRow = Record<string, DayValue>;

/** Hours per stage. Older iPhone-only nights have `inBed` and nothing else. */
export interface SleepNight {
  deep?: number;
  core?: number;
  rem?: number;
  awake?: number;
  asleep?: number;
  inBed?: number;
}

export interface Workout {
  type: string;
  /** Local time, 'YYYY-MM-DDTHH:MM'. */
  start: string;
  min: number | null;
  km: number | null;
  kcal: number | null;
  hr: number | null;
  /** Epoch ms, used to pair routes with workouts. */
  utc: number;
  /** 1 once a GPX route has been matched to this workout. */
  route?: 1;
}

/** The measured figures, shared by Workout and WorkoutInRange. */
export type WorkoutFigures = Pick<Workout, 'km' | 'min' | 'kcal' | 'hr'>;

export type LatLon = [lat: number, lon: number];

export interface Route {
  name: string;
  utc: number;
  km: number;
  pts: LatLon[];
  /** Copied from the workout it was matched to, else 'Unmatched'. */
  type: string;
  start: string;
}

export interface Meta {
  dob?: string;
  sex?: string;
  exported?: string;
}

export interface Aggregate {
  meta: Meta;
  routes: Route[];
  /** metric -> raw HealthKit unit, e.g. 'count/min'. */
  units: Record<string, string>;
  sumTypes: string[];
  days: Record<string, DayRow>;
  sleep: Record<string, SleepNight>;
  workouts: Workout[];
}

/** A workout plus its position in `Aggregate.workouts` and its route, if any. */
export type WorkoutInRange = Omit<Workout, 'route'> & {
  i: number;
  route: Route | null;
};

/** Messages the ingest worker posts back. */
export type IngestMessage =
  | { progress: number; label: string }
  | { result: Aggregate }
  | { error: string };
