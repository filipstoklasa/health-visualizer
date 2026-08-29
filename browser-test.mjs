/**
* node --test browser-test.mjs (builds first; drives the real bundle)
 *
 * The wiring node cannot reach: the module worker, a File crossing postMessage,
 * IndexedDB, and the page actually drawing. Drives real Chrome over CDP against
 * a throwaway static server. Skipped when Chrome is not installed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .find(bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 8800 + (process.pid % 300);
const DEBUG_PORT = 9600 + (process.pid % 300);

// A small but complete export: two days, a workout, and a route for it.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="cs_CZ">
 <ExportDate value="2024-03-01 10:00:00 +0100"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1994-06-09" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Watch" startDate="2024-01-01 08:00:00 +0100" endDate="2024-01-01 08:10:00 +0100" value="1200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="Watch" startDate="2024-01-02 08:00:00 +0100" endDate="2024-01-02 08:10:00 +0100" value="3400"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" sourceName="Watch" startDate="2024-01-01 08:00:00 +0100" endDate="2024-01-01 08:00:01 +0100" value="61"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" sourceName="Watch" startDate="2024-01-02 08:00:00 +0100" endDate="2024-01-02 08:00:01 +0100" value="77"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2024-01-01 23:00:00 +0100" endDate="2024-01-02 06:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="Watch" startDate="2024-01-01 10:00:00 +0100" endDate="2024-01-01 10:30:00 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5.25" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="300" unit="kcal"/>
 </Workout>
</HealthData>`;
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"><trk><trkseg>${Array.from({ length: 40 }, (_, i) =>
  `<trkpt lon="14.45" lat="${(50 + i * 0.0002).toFixed(4)}"><time>2024-01-01T09:00:${String(i % 60).padStart(2, '0')}Z</time></trkpt>`).join('')}</trkseg></trk></gpx>`;

let dir, server, chrome, ws, id = 0;
const pending = new Map();

const send = (method, params = {}) => new Promise((ok, no) => {
  const n = ++id;
  pending.set(n, { ok, no });
  ws.send(JSON.stringify({ id: n, method, params }));
});

/** Evaluate in the page. Fails fast rather than hanging the suite. */
const evaluate = async (expression, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(ms).then(() => { throw new Error(`timed out after ${ms}ms: ${expression.slice(0, 70)}`); }),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluation failed');
  return r.result.value;
};

const $hidden = sel => evaluate(`document.querySelector('${sel}').hidden`);
const $text = sel => evaluate(`document.querySelector('${sel}').textContent`);
const $count = sel => evaluate(`document.querySelectorAll('${sel}').length`);

describe('browser end to end', { skip: CHROME ? false : 'Chrome is not installed' }, () => {
  before(async () => {
    // The real production bundle, served from a directory with no health.json,
    // so the import path is the only way in.
    execFileSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: HERE, stdio: 'inherit' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-browser-'));
    fs.cpSync(path.join(HERE, 'dist'), dir, { recursive: true });
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(src, 'apple_health_export', 'workout-routes'), { recursive: true });
    fs.writeFileSync(path.join(src, 'apple_health_export', 'export.xml'), XML);
    fs.writeFileSync(path.join(src, 'apple_health_export', 'workout-routes', 'route_2024-01-01_10.00am.gpx'), GPX);
    execFileSync('python3', ['-c', `
import zipfile, os, sys
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, root))
`, src, path.join(dir, 'export.zip')]);

    server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: dir, stdio: 'ignore' });
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(dir, 'profile')}`,
      '--window-size=1400,1400', `http://localhost:${PORT}/index.html`], { stdio: 'ignore' });

    let targets;
    for (let i = 0; i < 60; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json(); if (targets.length) break; } catch { /* starting */ }
      await sleep(250);
    }
    const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    assert.ok(page, 'Chrome opened the page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.no(new Error(m.error.message)) : p.ok(m.result);
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(1200);
  });

  after(() => {
    ws?.close();
    chrome?.kill();
    server?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('asks for a zip when there is nothing stored', async () => {
    assert.equal(await $hidden('#import'), false, 'the import card is shown');
    assert.equal(await $hidden('#dash'), true, 'the dashboard stays hidden');
  });

  test('a dropped zip is parsed by the worker and rendered', async () => {
    await evaluate(`(async () => {
      const blob = await (await fetch('export.zip')).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'export.zip', { type: 'application/zip' }));
      window.__done = new Promise(ok => {
        const o = new MutationObserver(() => {
          if (!document.querySelector('#dash').hidden) { o.disconnect(); ok(1); }
        });
        o.observe(document.body, { subtree: true, attributes: true });
        setTimeout(() => ok(0), 25000);
      });
      dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    assert.equal(await evaluate('window.__done', 30000), 1, 'the dashboard appeared');
    assert.equal(await $hidden('#import'), true, 'the import card steps aside');
    assert.match(await $text('#meta'), /2024-01-01 → 2024-01-02 · 2 days · 1 workout/);
  });

  test('the page draws what it parsed', async () => {
    assert.ok(await $count('#metricChart svg rect') > 0, 'the metric chart has bars');
    assert.ok(await $count('#sleepChart svg rect') > 0, 'the sleep chart has bars');
    assert.equal(await $count('#workouts tbody tr'), 1, 'the workout is listed');
    assert.equal(await $count('#map path.leaflet-interactive'), 1, 'the route is on the map');
    assert.match(await $text('.tile .v'), /1,?200|2,?300/, 'the steps tile is filled in');
  });

  test('best sessions list the record runs and put one on the map when clicked', async () => {
    assert.ok(await $count('#bests .best') > 0, 'record tiles are rendered');
    assert.match(await $text('#bests .best'), /Longest run/);
    assert.match(await $text('#bests'), /5\.25 km · 30 min · 5:43 \/km · 300 kcal/, 'every figure is shown');
    await evaluate(`document.querySelector('#bests .best').click()`);
    assert.equal(await evaluate(`document.querySelector('#bests .best').getAttribute('aria-selected')`), 'true');
    assert.match(await $text('#mapNote'), /Running on 2024-01-01 10:00/, 'the map follows the pick');
    assert.equal(await $count('#map path.leaflet-interactive'), 1, 'its route is drawn');
    await evaluate(`document.querySelector('#showAll').click()`);
  });

  test('picking a workout reuses the table rows instead of rebuilding them', async () => {
    // The whole point of the per-key subscriptions: a selection must not
    // regenerate the table (thousands of rows on a real export) or the charts.
    await evaluate(`
      document.querySelector('#workouts tbody tr[data-i]').dataset.probe = 'kept';
      document.querySelector('#metricChart svg').dataset.probe = 'kept';
    `);
    await evaluate(`document.querySelector('#workouts tbody tr[data-i]').click()`);
    assert.equal(await evaluate(`document.querySelector('#workouts tbody tr[data-i]').dataset.probe`),
      'kept', 'the row is the same DOM node');
    assert.equal(await evaluate(`document.querySelector('#metricChart svg').dataset.probe`),
      'kept', 'the metric chart was not redrawn');
    assert.equal(await evaluate(`document.querySelector('#workouts tbody tr[data-i]').getAttribute('aria-selected')`),
      'true', 'but it is marked selected');
    await evaluate(`document.querySelector('#showAll').click()`);
  });

  test('selecting a row narrows the map but keeps every row', async () => {
    await evaluate(`document.querySelector('#workouts tbody tr[data-i]').click()`);
    assert.equal(await $count('#workouts tbody tr'), 1, 'rows stay visible');
    assert.equal(await evaluate(`!!document.querySelector('#showAll')`), true, 'a way back is offered');
    await evaluate(`document.querySelector('#showAll').click()`);
    assert.equal(await evaluate(`!!document.querySelector('#showAll')`), false, 'clearing the selection works');
  });

  test('the import survives a reload without the file', async () => {
    assert.match(await evaluate(`new Promise(ok => {
      const rq = indexedDB.open('health-visualizer', 1);
      rq.onsuccess = () => {
        const g = rq.result.transaction('data').objectStore('data').get('latest');
        g.onsuccess = () => ok(g.result ? Object.keys(g.result.data.days).length + ' days stored' : 'nothing stored');
      };
      rq.onerror = () => ok('could not open the database');
    })`), /2 days stored/);

    await send('Page.reload', { ignoreCache: true });
    await sleep(2500);
    assert.equal(await $hidden('#dash'), false, 'the dashboard is back');
    assert.equal(await $hidden('#import'), true, 'without asking for the zip again');
    assert.match(await $text('#meta'), /2 days/);
  });
});
