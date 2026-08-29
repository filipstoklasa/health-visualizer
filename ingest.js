/**
 * Apple Health export.zip -> the same aggregate parse_health.py produces.
 *
 * Runs as a module Worker in the browser; the pure pieces are exported so
 * node can test them (see test.mjs).
 */

// ---------- zip ----------
// Only what a stored/deflated zip needs. Zip64 is rejected loudly rather than
// mis-read: an Apple export is ~1 GB unpacked, well under the 4 GB fields.
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, U32_MAX = 0xffffffff;

const dv = buf => new DataView(buf);

/** @returns {Promise<Array<{name, method, compSize, size, offset}>>} */
export async function zipEntries(blob) {
  const tailLen = Math.min(blob.size, 65557);           // max comment + EOCD
  const tail = dv(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === U32_MAX || cdSize === U32_MAX || count === 0xffff) {
    throw new Error('Zip64 archives are not supported — unzip it and use the folder instead.');
  }

  const cd = dv(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const names = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== CD_SIG) throw new Error('Corrupt central directory.');
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const compSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const offset = cd.getUint32(p + 42, true);
    if (compSize === U32_MAX || size === U32_MAX || offset === U32_MAX) {
      throw new Error('Zip64 entry sizes are not supported.');
    }
    entries.push({
      name: names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)),
      method: cd.getUint16(p + 10, true),
      compSize, size, offset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** iOS Safari has no ReadableStream async iteration; getReader() works everywhere. */
export async function* streamChunks(stream) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Byte stream of one entry, inflated if needed. */
export async function entryStream(blob, e) {
  const head = dv(await blob.slice(e.offset, e.offset + 30).arrayBuffer());
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = blob.slice(start, start + e.compSize).stream();
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error(`Unsupported zip compression method ${e.method}.`);
  return raw.pipeThrough(new DecompressionStream('deflate-raw'));
}

export async function entryText(blob, e) {
  const chunks = [];
  for await (const c of streamChunks(await entryStream(blob, e))) chunks.push(c);
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

// ---------- health records ----------
// Types summed over the day; everything else is averaged (with min/max kept).
export const SUM_TYPES = [
  'ActiveEnergyBurned', 'AppleExerciseTime', 'AppleStandTime', 'BasalEnergyBurned',
  'DietaryCaffeine', 'DietaryEnergyConsumed', 'DietaryWater', 'DistanceCycling',
  'DistanceSkatingSports', 'DistanceSwimming', 'DistanceWalkingRunning', 'FlightsClimbed',
  'NumberOfAlcoholicBeverages', 'PhysicalEffort', 'StepCount', 'TimeInDaylight',
];
const SUM = new Set(SUM_TYPES);
const SLEEP_STAGES = {
  InBed: 'inBed', AsleepUnspecified: 'asleep', AsleepCore: 'core',
  AsleepDeep: 'deep', AsleepREM: 'rem', Awake: 'awake',
};
const DISTANCE_STATS = ['DistanceWalkingRunning', 'DistanceCycling', 'DistanceSwimming', 'DistanceSkatingSports'];

const TAG = /<([A-Za-z]+)([^>]*)>/g;
const ATTR = /([A-Za-z]+)="([^"]*)"/g;
const WANTED = new Set(['Record', 'Workout', 'WorkoutStatistics', 'Me', 'ExportDate']);

const attrs = src => {
  const out = {};
  ATTR.lastIndex = 0;
  for (let m; (m = ATTR.exec(src));) out[m[1]] = m[2];
  return out;
};
const short = (s, prefix) => (s && s.startsWith(prefix) ? s.slice(prefix.length) : s);
export const rnd = v => (v == null || v === '' || Number.isNaN(+v) ? null : Math.round(+v * 100) / 100);

/** '2021-11-30 01:30:00 +0200' | '2021-11-30T01:30:00Z' -> epoch seconds */
export function ts(s) {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T').replace(/ (\+|-)(\d{2})(\d{2})$/, '$1$2:$3'));
  return Number.isNaN(t) ? null : t / 1000;
}

export class Aggregator {
  constructor() {
    this.days = new Map();      // date -> metric -> accumulator
    this.sleep = new Map();     // date -> bucket -> hours
    this.workouts = [];
    this.units = {};
    this.meta = {};
    this.routes = [];
    this.tail = '';
    this.workout = null;        // <Workout> currently open, for its statistics
  }

  /** Feed XML text. Chunks may split a tag anywhere; the remainder is carried. */
  feed(text) {
    const s = this.tail + text;
    let end = 0;
    TAG.lastIndex = 0;
    for (let m; (m = TAG.exec(s));) {
      end = TAG.lastIndex;
      if (WANTED.has(m[1])) this.tag(m[1], m[2]);
    }
    this.tail = s.slice(end);
  }

  tag(name, raw) {
    const a = attrs(raw);
    if (name === 'Record') this.record(a);
    else if (name === 'Workout') this.openWorkout(a);
    else if (name === 'WorkoutStatistics') {
      // statistics only ever appear inside the workout they describe
      if (this.workout) this.workout.stats[short(a.type, 'HKQuantityTypeIdentifier')] = a;
    } else if (name === 'Me') {
      this.meta.dob = a.HKCharacteristicTypeIdentifierDateOfBirth;
      this.meta.sex = short(a.HKCharacteristicTypeIdentifierBiologicalSex, 'HKBiologicalSex');
    } else if (name === 'ExportDate') this.meta.exported = a.value;
  }

  record(a) {
    const day = (a.startDate || '').slice(0, 10);
    if (!day) return;
    if (a.type === 'HKCategoryTypeIdentifierSleepAnalysis') {
      const bucket = SLEEP_STAGES[short(a.value, 'HKCategoryValueSleepAnalysis')];
      if (!bucket) return;
      const hrs = (ts(a.endDate) - ts(a.startDate)) / 3600;
      // a night is credited to the day it ends on
      const night = a.endDate.slice(0, 10);
      let b = this.sleep.get(night);
      if (!b) this.sleep.set(night, b = {});
      b[bucket] = (b[bucket] || 0) + hrs;
      return;
    }
    if (!a.type?.startsWith('HKQuantityTypeIdentifier')) return;
    const v = +a.value;
    if (a.value == null || a.value === '' || Number.isNaN(v)) return;
    const metric = short(a.type, 'HKQuantityTypeIdentifier');
    if (this.units[metric] === undefined) this.units[metric] = a.unit ?? '';
    let row = this.days.get(day);
    if (!row) this.days.set(day, row = new Map());
    if (SUM.has(metric)) {
      // iPhone and Watch both log the same walk, so keep totals per source
      let per = row.get(metric);
      if (!per) row.set(metric, per = new Map());
      per.set(a.sourceName ?? '?', (per.get(a.sourceName ?? '?') || 0) + v);
    } else {
      const acc = row.get(metric);
      if (!acc) row.set(metric, [v, v, v, 1]);
      else {
        acc[0] += v;
        if (v < acc[1]) acc[1] = v;
        if (v > acc[2]) acc[2] = v;
        acc[3]++;
      }
    }
  }

  openWorkout(a) {
    this.workout = {
      type: short(a.workoutActivityType, 'HKWorkoutActivityType'),
      start: (a.startDate || '').slice(0, 16),
      min: rnd(a.duration),
      km: rnd(a.totalDistance),
      kcal: rnd(a.totalEnergyBurned),
      hr: null,
      utc: ts(a.startDate),
      stats: {},
    };
    this.workouts.push(this.workout);
  }

  /** One GPX route: thinned to a point every MIN_GAP_M, distance measured full-resolution. */
  addGpx(name, text) {
    const MIN_GAP_M = 8, MAX_POINTS = 600;
    const pts = [];
    let start = null, dist = 0, prev = null, kept = null;
    TRKPT.lastIndex = 0;
    for (let m; (m = TRKPT.exec(text));) {
      const p = [+m[2], +m[1]];
      if (start === null) start = m[3];
      if (prev) dist += metres(prev, p);
      prev = p;
      if (!kept || metres(kept, p) >= MIN_GAP_M) { pts.push([round5(p[0]), round5(p[1])]); kept = p; }
    }
    if (pts.length < 2) return;
    // keep the true end point, unless it is already the last kept one
    if (metres(kept, prev) >= 1) pts.push([round5(prev[0]), round5(prev[1])]);
    let out = pts;
    if (pts.length > MAX_POINTS) {                       // keep both ends, thin the middle
      const step = pts.length / MAX_POINTS;
      out = Array.from({ length: MAX_POINTS }, (_, i) => pts[Math.floor(i * step)]).concat([pts[pts.length - 1]]);
    }
    this.routes.push({ name: name.replace(/^.*\//, '').slice(6, -4).replace(/_/g, ' '), utc: ts(start), km: rnd(dist / 1000), pts: out });
  }

  finish() {
    const days = {};
    for (const date of [...this.days.keys()].sort()) {
      const row = {};
      for (const [metric, acc] of this.days.get(date)) {
        if (SUM.has(metric)) {
          // ponytail: trust the single source that logged the most that day; a real
          // de-dup would union overlapping record intervals across sources.
          row[metric] = rnd(Math.max(...acc.values()));
        } else {
          row[metric] = [rnd(acc[0] / acc[3]), rnd(acc[1]), rnd(acc[2])];
        }
      }
      days[date] = row;
    }

    const sleep = {};
    for (const date of [...this.sleep.keys()].sort()) {
      const b = this.sleep.get(date), out = {};
      for (const k of Object.keys(b)) out[k] = rnd(b[k]);
      sleep[date] = out;
    }

    const workouts = this.workouts.map(w => {
      const d = DISTANCE_STATS.map(k => w.stats[k]).find(Boolean);
      const e = w.stats.ActiveEnergyBurned, hr = w.stats.HeartRate;
      const { stats, ...rest } = w;
      return { ...rest, km: w.km ?? rnd(d?.sum), kcal: w.kcal ?? rnd(e?.sum), hr: rnd(hr?.average) };
    }).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    // attach each route to the workout that started nearest it (within 20 min)
    for (const r of this.routes) {
      let best = null;
      for (const w of workouts) {
        if (best === null || Math.abs(w.utc - r.utc) < Math.abs(best.utc - r.utc)) best = w;
      }
      if (best && Math.abs(best.utc - r.utc) <= 1200) { r.type = best.type; r.start = best.start; best.route = 1; }
      else { r.type = 'Unmatched'; r.start = r.name.slice(0, 10); }
    }
    const routes = this.routes.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    return { meta: this.meta, routes, units: sortKeys(this.units), sumTypes: SUM_TYPES, days, sleep, workouts };
  }
}

const TRKPT = /<trkpt lon="([-\d.]+)" lat="([-\d.]+)"[\s\S]*?<time>([^<]+)<\/time>/g;
const round5 = v => Math.round(v * 1e5) / 1e5;
const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));

/** Equirectangular approximation - plenty for thinning a GPS track. */
export function metres(a, b) {
  const rad = Math.PI / 180, lat = (a[0] + b[0]) / 2 * rad;
  return 6371000 * Math.hypot((b[0] - a[0]) * rad, (b[1] - a[1]) * rad * Math.cos(lat));
}

// ---------- driver ----------
/** Ingest a picked export.zip. `onProgress(fraction, label)` is optional. */
export async function ingestZip(blob, onProgress = () => {}) {
  const entries = await zipEntries(blob);
  const xml = entries.find(e => /(^|\/)export\.xml$/.test(e.name));
  if (!xml) throw new Error('No export.xml in this zip — is it an Apple Health export?');
  const gpx = entries.filter(e => /workout-routes\/.*\.gpx$/.test(e.name));

  const agg = new Aggregator();
  let read = 0;
  const decoder = new TextDecoderStream();
  const stream = (await entryStream(blob, xml)).pipeThrough(decoder);
  for await (const chunk of streamChunks(stream)) {
    agg.feed(chunk);
    read += chunk.length;
    onProgress(Math.min(0.9, (read / Math.max(xml.size, 1)) * 0.9), 'Reading health records');
  }
  for (let i = 0; i < gpx.length; i++) {
    agg.addGpx(gpx[i].name, await entryText(blob, gpx[i]));
    onProgress(0.9 + 0.1 * (i + 1) / gpx.length, `Reading GPS routes (${i + 1}/${gpx.length})`);
  }
  return agg.finish();
}

// ---------- worker glue ----------
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data }) => {
    try {
      const result = await ingestZip(data.file, (progress, label) => self.postMessage({ progress, label }));
      self.postMessage({ result });
    } catch (e) {
      self.postMessage({ error: e.message });
    }
  };
}
