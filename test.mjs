/**
 * node --test test.mjs
 *
 * Covers the browser ingest (ingest.js), the view logic inside index.html, and
 * cross-checks both against parse_health.py on the same fixture.
 *
 * HEALTH_REAL=1 also runs the real 633 MB export through the browser pipeline.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Aggregator, zipEntries, entryText, ingestZip, metres, ts, rnd } from './ingest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- fixture ----------
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="cs_CZ">
 <ExportDate value="2024-03-01 10:00:00 +0100"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1994-06-09" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Watch" startDate="2024-01-01 08:00:00 +0100" endDate="2024-01-01 08:10:00 +0100" value="100"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Watch" startDate="2024-01-01 09:00:00 +0100" endDate="2024-01-01 09:10:00 +0100" value="50"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Phone" startDate="2024-01-01 08:00:00 +0100" endDate="2024-01-01 08:10:00 +0100" value="90"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Watch" startDate="2024-01-02 08:00:00 +0100" endDate="2024-01-02 08:10:00 +0100" value="7"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" sourceName="Watch" startDate="2024-01-01 08:00:00 +0100" endDate="2024-01-01 08:00:01 +0100" value="60">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
 </Record>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" sourceName="Watch" startDate="2024-01-01 08:01:00 +0100" endDate="2024-01-01 08:01:01 +0100" value="80"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" sourceName="Phone" startDate="2024-01-01 08:02:00 +0100" endDate="2024-01-01 08:02:01 +0100" value="100"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" sourceName="Scale" startDate="2024-01-01 07:00:00 +0100" endDate="2024-01-01 07:00:00 +0100" value="80.5"/>
 <Record type="HKQuantityTypeIdentifierRespiratoryRate" unit="count/min" sourceName="Watch" startDate="2024-01-01 07:00:00 +0100" endDate="2024-01-01 07:00:00 +0100"/>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Phone" startDate="2024-01-01 07:00:00 +0100" endDate="2024-01-01 07:00:00 +0100">
  <MetadataEntry key="x" value="y"/>
 </Correlation>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2024-01-01 23:00:00 +0100" endDate="2024-01-02 05:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2024-01-02 05:00:00 +0100" endDate="2024-01-02 05:30:00 +0100" value="HKCategoryValueSleepAnalysisAsleepREM"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Phone" startDate="2024-01-03 23:00:00 +0100" endDate="2024-01-04 06:30:00 +0100" value="HKCategoryValueSleepAnalysisInBed"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Watch" startDate="2024-01-01 10:00:00 +0100" endDate="2024-01-01 10:30:00 +0100">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-01-01 10:05:00 +0100" duration="5" durationUnit="min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="2024-01-01 10:00:00 +0100" endDate="2024-01-01 10:30:00 +0100" sum="5.25" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-01-01 10:00:00 +0100" endDate="2024-01-01 10:30:00 +0100" sum="300" unit="kcal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="2024-01-01 10:00:00 +0100" endDate="2024-01-01 10:30:00 +0100" average="150.4" minimum="90" maximum="180" unit="count/min"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTennis" duration="60" durationUnit="min" totalDistance="2.5" totalDistanceUnit="km" totalEnergyBurned="400" totalEnergyBurnedUnit="kcal" sourceName="Watch" startDate="2024-01-02 18:00:00 +0100" endDate="2024-01-02 19:00:00 +0100"/>
</HealthData>
`;

// ~11 m apart, so the 8 m thinning keeps every point
const gpxPoints = (n, lat0 = 50.0, day = '2024-01-01') => Array.from({ length: n }, (_, i) =>
  `<trkpt lon="14.45" lat="${(lat0 + i * 0.0001).toFixed(4)}"><ele>0</ele><time>${day}T09:00:${String(i).padStart(2, '0')}Z</time>`
  + `<extensions><speed>1.5</speed></extensions></trkpt>`).join('\n');
const gpx = (n, lat0, day) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export"><trk><name>Route</name><trkseg>
${gpxPoints(n, lat0, day)}
</trkseg></trk></gpx>`;

const FIXTURE = {
  'apple_health_export/export.xml': XML,
  'apple_health_export/workout-routes/route_2024-01-01_10.00am.gpx': gpx(5),
  'apple_health_export/workout-routes/route_2024-01-05_9.00am.gpx': gpx(3, 51.0, '2024-01-05'),  // no workout near it
  'apple_health_export/workout-routes/route_2024-01-06_9.00am.gpx': gpx(1, 52.0, '2024-01-06'),  // too short to draw
  'apple_health_export/electrocardiograms/ecg.csv': 'not,health,records\n',
};

let dir, zipBlob;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
  for (const [name, body] of Object.entries(FIXTURE)) {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  // Built by python's zipfile, not by us: an independent encoder is the point.
  // export.xml deflated, the rest stored, so both methods get exercised.
  const zipPath = path.join(dir, 'export.zip');
  execFileSync('python3', ['-c', `
import zipfile, sys, os
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w") as z:
    for name in ${JSON.stringify(Object.keys(FIXTURE))}:
        z.write(os.path.join(root, name), name,
                zipfile.ZIP_DEFLATED if name.endswith("export.xml") else zipfile.ZIP_STORED)
`, dir, zipPath]);
  zipBlob = new Blob([fs.readFileSync(zipPath)]);
});

const feedAll = (xml, chunk = Infinity) => {
  const agg = new Aggregator();
  for (let i = 0; i < xml.length; i += chunk) agg.feed(xml.slice(i, i + chunk));
  return agg;
};

// ---------- zip ----------
describe('zip reader', () => {
  test('lists every entry with its method', async () => {
    const entries = await zipEntries(zipBlob);
    assert.equal(entries.length, Object.keys(FIXTURE).length);
    const xml = entries.find(e => e.name.endsWith('export.xml'));
    assert.equal(xml.method, 8, 'export.xml is deflated');
    assert.equal(xml.size, Buffer.byteLength(XML));
    assert.equal(entries.find(e => e.name.endsWith('.csv')).method, 0, 'csv is stored');
  });

  test('reads both stored and deflated entries back byte-for-byte', async () => {
    const entries = await zipEntries(zipBlob);
    for (const name of ['export.xml', 'ecg.csv']) {
      const e = entries.find(x => x.name.endsWith(name));
      const got = await entryText(zipBlob, e);
      assert.equal(got, FIXTURE[e.name], `${name} round-trips`);
    }
  });

  test('reads a zip on a browser without ReadableStream async iteration (iOS Safari)', async () => {
    const orig = ReadableStream.prototype[Symbol.asyncIterator];
    delete ReadableStream.prototype[Symbol.asyncIterator];
    try {
      const entries = await zipEntries(zipBlob);
      const xml = entries.find(e => e.name.endsWith('export.xml'));
      assert.equal(await entryText(zipBlob, xml), FIXTURE[xml.name]);
      assert.ok((await ingestZip(zipBlob)).days);
    } finally {
      ReadableStream.prototype[Symbol.asyncIterator] = orig;
    }
  });

  test('rejects something that is not a zip', async () => {
    await assert.rejects(() => zipEntries(new Blob(['just some text'])), /not a zip/i);
  });

  test('rejects a zip with no export.xml', async () => {
    const zipPath = path.join(dir, 'other.zip');
    execFileSync('python3', ['-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("notes.txt","hi"); z.close()', zipPath]);
    await assert.rejects(() => ingestZip(new Blob([fs.readFileSync(zipPath)])), /No export\.xml/);
  });
});

// ---------- aggregation ----------
describe('record aggregation', () => {
  test('cumulative metrics keep the biggest single source, never the sum', () => {
    const d = feedAll(XML).finish().days;
    assert.equal(d['2024-01-01'].StepCount, 150, 'Watch 100+50 beats Phone 90; 240 would be double counting');
    assert.equal(d['2024-01-02'].StepCount, 7);
  });

  test('other metrics become [avg, min, max] across all sources', () => {
    const d = feedAll(XML).finish().days;
    assert.deepEqual(d['2024-01-01'].HeartRate, [80, 60, 100]);
    assert.deepEqual(d['2024-01-01'].BodyMass, [80.5, 80.5, 80.5]);
  });

  test('records with no value are skipped, not counted as zero', () => {
    const d = feedAll(XML).finish().days;
    assert.equal(d['2024-01-01'].RespiratoryRate, undefined);
  });

  test('units and metadata are captured', () => {
    const r = feedAll(XML).finish();
    assert.equal(r.units.HeartRate, 'count/min');
    assert.equal(r.units.BodyMass, 'kg');
    assert.equal(r.meta.sex, 'Male');
    assert.equal(r.meta.dob, '1994-06-09');
    assert.equal(r.meta.exported, '2024-03-01 10:00:00 +0100');
  });

  test('a night is credited to the day it ends on', () => {
    const s = feedAll(XML).finish().sleep;
    assert.equal(s['2024-01-01'], undefined, 'sleep starting at 23:00 does not land on the 1st');
    assert.deepEqual(s['2024-01-02'], { core: 6, rem: 0.5 });
    assert.deepEqual(s['2024-01-04'], { inBed: 7.5 }, 'stageless iPhone nights stay separate');
  });

  test('workout stats come from child elements or attributes, whichever the export used', () => {
    const w = feedAll(XML).finish().workouts;
    assert.equal(w.length, 2);
    assert.deepEqual(
      { ...w[0], route: undefined },
      { type: 'Running', start: '2024-01-01 10:00', min: 30, km: 5.25, kcal: 300, hr: 150.4, utc: ts('2024-01-01 10:00:00 +0100'), route: undefined });
    assert.equal(w[1].km, 2.5, 'older exports put distance in an attribute');
    assert.equal(w[1].kcal, 400);
    assert.equal(w[1].hr, null, 'no heart-rate statistics on that one');
  });

  test('workouts come out in start order', () => {
    const w = feedAll(XML).finish().workouts;
    assert.deepEqual(w.map(x => x.start), ['2024-01-01 10:00', '2024-01-02 18:00']);
  });

  test('days and sleep keys come out sorted', () => {
    const r = feedAll(XML).finish();
    assert.deepEqual(Object.keys(r.days), [...Object.keys(r.days)].sort());
    assert.deepEqual(Object.keys(r.sleep), [...Object.keys(r.sleep)].sort());
  });
});

describe('chunked feeding', () => {
  // The streaming bug that matters: a tag split across two reads.
  for (const size of [1, 2, 3, 7, 64, 997, 8192]) {
    test(`${size}-char chunks give the same result as one shot`, () => {
      assert.deepEqual(feedAll(XML, size).finish(), feedAll(XML).finish());
    });
  }

  test('a chunk boundary inside a UTF-8 sequence does not corrupt text', async () => {
    // TextDecoderStream handles this; prove the seam works end to end.
    const xml = XML.replace('sourceName="Scale"', 'sourceName="Váha – Filip’s"');
    const agg = new Aggregator();
    const bytes = new TextEncoder().encode(xml);
    const dec = new TextDecoder();
    for (let i = 0; i < bytes.length; i += 5) agg.feed(dec.decode(bytes.slice(i, i + 5), { stream: true }));
    assert.deepEqual(agg.finish().days['2024-01-01'].BodyMass, [80.5, 80.5, 80.5]);
  });
});

// ---------- routes ----------
describe('gpx routes', () => {
  test('thins to one point per 8 m and measures distance at full resolution', () => {
    const agg = new Aggregator();
    agg.addGpx('route_2024-01-01_10.00am.gpx', gpx(5));
    const [r] = agg.finish().routes;
    assert.equal(r.pts.length, 5, '11 m apart, so nothing is dropped');
    assert.deepEqual(r.pts[0], [50, 14.45]);
    assert.equal(r.km, 0.04, '4 hops of ~11 m');
  });

  test('drops points closer together than the threshold', () => {
    const agg = new Aggregator();
    const dense = `<gpx><trk><trkseg>${Array.from({ length: 20 }, (_, i) =>
      `<trkpt lon="14.45" lat="${(50 + i * 0.00001).toFixed(5)}"><time>2024-01-01T09:00:0${i % 10}Z</time></trkpt>`).join('')}</trkseg></trk></gpx>`;
    agg.addGpx('route_2024-01-01_10.00am.gpx', dense);
    const [r] = agg.finish().routes;
    assert.ok(r.pts.length < 20 && r.pts.length >= 2, `thinned to ${r.pts.length}`);
  });

  test('caps very long routes but keeps both ends', () => {
    const agg = new Aggregator();
    agg.addGpx('route_2024-01-01_10.00am.gpx', gpx(2000));
    const [r] = agg.finish().routes;
    assert.ok(r.pts.length <= 601, `capped at ${r.pts.length}`);
    assert.deepEqual(r.pts[0], [50, 14.45]);
    assert.deepEqual(r.pts.at(-1), [50.1999, 14.45]);
  });

  test('a route with one point is dropped', () => {
    const agg = new Aggregator();
    agg.addGpx('route_2024-01-06_9.00am.gpx', gpx(1, 52, '2024-01-06'));
    assert.equal(agg.finish().routes.length, 0);
  });

  test('routes link to the workout that started nearest them', () => {
    const agg = feedAll(XML);
    agg.addGpx('apple_health_export/workout-routes/route_2024-01-01_10.00am.gpx', gpx(5));
    agg.addGpx('apple_health_export/workout-routes/route_2024-01-05_9.00am.gpx', gpx(3, 51, '2024-01-05'));
    const { routes, workouts } = agg.finish();
    const linked = routes.find(r => r.type === 'Running');
    assert.equal(linked.start, '2024-01-01 10:00');
    assert.equal(workouts[0].route, 1, 'the workout is flagged as having a track');
    const orphan = routes.find(r => r.type === 'Unmatched');
    assert.ok(orphan, 'a route with no workout within 20 min is not force-matched');
    assert.equal(orphan.start, '2024-01-05');
    assert.equal(workouts[1].route, undefined, 'the tennis workout gets no route');
  });

  test('metres() is sane against known distances', () => {
    assert.ok(Math.abs(metres([50, 14], [50.001, 14]) - 111.2) < 1, 'one milli-degree of latitude');
    assert.ok(Math.abs(metres([50, 14], [50, 14.001]) - 71.5) < 1, 'longitude shrinks with latitude');
    assert.equal(metres([50, 14], [50, 14]), 0);
  });
});

describe('helpers', () => {
  test('ts() understands both export and gpx timestamps', () => {
    assert.equal(ts('2024-01-01 10:00:00 +0100'), Date.UTC(2024, 0, 1, 9) / 1000);
    assert.equal(ts('2024-01-01T09:00:00Z'), Date.UTC(2024, 0, 1, 9) / 1000);
    assert.equal(ts(''), null);
  });
  test('rnd() keeps two decimals and passes blanks through', () => {
    assert.equal(rnd('5.256'), 5.26);
    assert.equal(rnd(undefined), null);
    assert.equal(rnd(''), null);
    assert.equal(rnd('nonsense'), null);
  });
});

// ---------- whole pipeline ----------
describe('ingestZip', () => {
  test('turns a zip into the full aggregate', async () => {
    const seen = [];
    const data = await ingestZip(zipBlob, (p, label) => seen.push([p, label]));
    assert.equal(data.days['2024-01-01'].StepCount, 150);
    assert.equal(data.workouts.length, 2);
    assert.equal(data.routes.length, 2, 'the single-point route is dropped');
    assert.ok(data.sumTypes.includes('StepCount'));
    assert.ok(seen.length > 0, 'reports progress');
    assert.ok(seen.every(([p]) => p >= 0 && p <= 1), 'progress stays in range');
    assert.equal(seen.at(-1)[0], 1, 'finishes at 100%');
  });

  test('matches parse_health.py on the same data', async () => {
    const out = path.join(dir, 'py.json');
    execFileSync('python3', [path.join(HERE, 'parse_health.py'), path.join(dir, 'apple_health_export'), out]);
    const py = JSON.parse(fs.readFileSync(out, 'utf8'));
    const js = await ingestZip(zipBlob);
    // Python rounds half-to-even, JS half-up; allow a last-decimal difference.
    same(js, py, 'root');
  });
});

/** Deep-equal, but numbers only have to agree to the rounding both sides do. */
function same(a, b, at) {
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(Math.abs(a - b) <= 0.011, `${at}: ${a} vs ${b}`);
  } else if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${at}: array shape`);
    assert.equal(a.length, b.length, `${at}: length`);
    a.forEach((v, i) => same(v, b[i], `${at}[${i}]`));
  } else if (a && b && typeof a === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${at}: keys`);
    for (const k of Object.keys(a)) same(a[k], b[k], `${at}.${k}`);
  } else {
    assert.equal(a, b, at);
  }
}

// ---------- the view logic inside index.html ----------
describe('view logic', () => {
  let V, DATA;
  before(async () => {
    const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
    const js = html.split('<script type="module">')[1].split('// ---------- map ----------')[0]
      .replace(/^const \$ = .*$/m, 'const $ = () => ({});');
    globalThis.location = { search: '' };
    globalThis.history = { replaceState() {} };
    V = new Function('_data', `${js}\n DATA = _data; return { series, sleepSeries, rangeDates, niceTicks,`
      + ' xLabel, night, asleepHours, bucketOf, bucketKey, label, unit, fmt,'
      + ' bestRuns, paceText, sessionLine, set: s => { state = s; } };');
    DATA = await ingestZip(zipBlob);
    V = V(DATA);
  });

  test('buckets stay under the mark budget at every range', () => {
    assert.equal(V.bucketOf(370), 'day');
    assert.equal(V.bucketOf(371), 'week');
    assert.equal(V.bucketOf(1101), 'month');
  });

  test('weeks start on Monday', () => {
    assert.equal(V.bucketKey('2026-08-29', 'week'), '2026-08-24');
    assert.equal(V.bucketKey('2026-08-24', 'week'), '2026-08-24');
    assert.equal(V.bucketKey('2026-08-29', 'month'), '2026-08');
  });

  test('a bucket reports per-day values, not a sum of differently sized buckets', () => {
    V.set({ days: 0, metric: 'StepCount' });
    const dates = V.rangeDates();
    const s = V.series('StepCount', dates);
    assert.equal(s.isSum, true);
    // 150 on the 1st and 7 on the 2nd -> the daily average, whatever the bucket
    assert.ok(Math.abs(s.points.reduce((a, p) => a + p.v, 0) / s.points.length - 78.5) < 1);
  });

  test('min <= avg <= max holds for averaged metrics', () => {
    V.set({ days: 0, metric: 'HeartRate' });
    for (const p of V.series('HeartRate', V.rangeDates()).points) {
      assert.ok(p.lo <= p.v && p.v <= p.hi, `${p.lo} <= ${p.v} <= ${p.hi}`);
    }
  });

  test('every metric in the data can be plotted', () => {
    V.set({ days: 0, metric: 'StepCount' });
    const dates = V.rangeDates();
    const present = new Set(Object.values(DATA.days).flatMap(Object.keys));
    for (const k of present) {
      const s = V.series(k, dates);
      assert.ok(s.points.length > 0, `${k} has points`);
      assert.ok(s.points.every(p => Number.isFinite(p.v)), `${k} has no NaN`);
    }
  });

  test('axis ticks always cover the data', () => {
    for (const max of [0, 0.42, 7, 9700, 123456]) {
      const t = V.niceTicks(max);
      assert.ok(t.at(-1) >= max, `${max} -> ${t.at(-1)}`);
      assert.equal(t[0], 0, 'bars are measured from zero');
    }
  });

  test('unstaged nights are kept apart from staged sleep', () => {
    assert.deepEqual(V.night({ inBed: 6.5 }), { deep: 0, core: 0, rem: 0, awake: 0, inBed: 6.5 });
    assert.equal(V.asleepHours({ core: 4, deep: 1, rem: 1.5, awake: 0.3 }), 6.5, 'awake time is not sleep');
    assert.equal(V.asleepHours({ asleep: 5, awake: 1 }), 5, 'legacy "asleep" counts');
    assert.equal(V.asleepHours({ inBed: 7 }), 7);
  });

  test('sleep buckets never come out empty', () => {
    V.set({ days: 0, metric: 'StepCount' });
    for (const p of V.sleepSeries(V.rangeDates()).points) {
      assert.ok(p.parts.reduce((a, b) => a + b, 0) > 0);
      assert.ok(p.parts.every(Number.isFinite));
    }
  });

  test('metric labels read as words', () => {
    assert.equal(V.label('StepCount'), 'Step Count');
    assert.equal(V.label('DistanceWalkingRunning'), 'Walking + running distance');
    assert.equal(V.unit('HeartRate'), 'bpm');
  });

  test('pace reads as minutes and seconds per km', () => {
    assert.equal(V.paceText({ km: 5, min: 25 }), '5:00 /km');
    assert.equal(V.paceText({ km: 5.25, min: 30 }), '5:43 /km');
    assert.equal(V.paceText({ km: 0, min: 30 }), null, 'no distance, no pace');
    assert.equal(V.paceText({ km: 5, min: null }), null);
  });

  test('a session line carries every figure there is, and skips the ones there are not', () => {
    assert.equal(V.sessionLine({ km: 5.25, min: 30, kcal: 300, hr: 150 }), '5.25 km · 30 min · 5:43 /km · 300 kcal · 150 bpm');
    assert.equal(V.sessionLine({ km: null, min: 60, kcal: null, hr: null }), '60 min');
  });

  test('best runs pick the record holder in each category', () => {
    const runs = [
      { i: 0, type: 'Running', start: '2024-01-01 08:00', km: 10, min: 60, kcal: 700, hr: 150 },   // longest, longest time, most energy
      { i: 1, type: 'Running', start: '2024-01-02 08:00', km: 5, min: 22, kcal: 300, hr: 165 },    // fastest over the distance floor
      { i: 2, type: 'Running', start: '2024-01-03 08:00', km: 0.5, min: 1.5, kcal: 40, hr: 170 },  // a sprint - must not win pace
      { i: 3, type: 'Walking', start: '2024-01-04 08:00', km: 20, min: 300, kcal: 900, hr: 90 },   // not a run
    ];
    const got = Object.fromEntries(V.bestRuns(runs).map(([title, w]) => [title, w.i]));
    assert.deepEqual(got, { 'Longest run': 0, 'Fastest pace': 1, 'Longest time': 0, 'Most energy': 0 });
  });

  test('best runs ignore categories with no data instead of inventing one', () => {
    const runs = [{ i: 0, type: 'Running', start: '2024-01-01 08:00', km: null, min: 30, kcal: null, hr: null }];
    assert.deepEqual(V.bestRuns(runs).map(([t]) => t), ['Longest time']);
    assert.deepEqual(V.bestRuns([{ i: 0, type: 'Walking', km: 5, min: 30 }]), [], 'walks are not runs');
    assert.deepEqual(V.bestRuns([]), []);
  });

  test('fmt() is readable at every magnitude', () => {
    assert.equal(V.fmt(null), '–');
    assert.equal(V.fmt(0.123), '0.12');
    assert.equal(V.fmt(12.34), '12.3');
    assert.equal(V.fmt(9070), '9,070');
  });
});

// ---------- the real export, opt-in ----------
describe('real export', { skip: !process.env.HEALTH_REAL }, () => {
  test('browser pipeline agrees with parse_health.py on the real data', async () => {
    const zipPath = path.join(os.tmpdir(), 'health-real.zip');
    if (!fs.existsSync(zipPath)) {
      execFileSync('python3', ['-c', `
import zipfile, os, sys
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for base, _, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, os.path.dirname(root)))
`, path.join(HERE, 'apple_health_export'), zipPath], { stdio: 'inherit' });
    }
    const t0 = Date.now();
    const js = await ingestZip(new Blob([fs.readFileSync(zipPath)]));
    console.log(`      ingested the real export in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const py = JSON.parse(fs.readFileSync(path.join(HERE, 'health.json'), 'utf8'));
    assert.equal(Object.keys(js.days).length, Object.keys(py.days).length);
    assert.equal(js.workouts.length, py.workouts.length);
    assert.equal(js.routes.length, py.routes.length);
    same(js, py, 'real');
  });
});
