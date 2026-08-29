# Health Visualizer

[![CI](https://github.com/filipstoklasa/health-visualizer/actions/workflows/ci.yml/badge.svg)](https://github.com/filipstoklasa/health-visualizer/actions/workflows/ci.yml)

A dashboard for your Apple Health export that never uploads your health data.

Export `export.zip` from the Health app, drop it on the page, and get daily
metrics, sleep stages, workout records and GPS routes. The zip is unpacked and
parsed **in your browser** — in a Web Worker, with no network round trip. Only
the ~2 MB aggregate is kept, in IndexedDB on your own machine.

## Why it works this way

An Apple Health export is a ~1 GB `export.xml` inside a zip. Uploading that to a
server means handing someone your heart rate, sleep and location history. So the
zip reader, the DEFLATE step and the XML parser all run client-side, streaming,
in a worker — the page stays responsive and the raw export never leaves the
device. What is stored afterwards is a small daily aggregate, not the records.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Open the page and drop your `export.zip` on it. On your iPhone:
**Health → your picture (top right) → Export All Health Data**.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests — parsing, aggregation, view logic |
| `npm run test:browser` | End-to-end tests driving real Chrome over CDP |

## Architecture

```
index.html          markup only
src/
  main.ts           boot, wiring, per-key render subscriptions
  state.ts          view state (range/metric/selection) + URL sync
  types.ts          the aggregate contract, shared by every consumer
  data.ts           pure shaping: bucketing, series, sleep, best runs
  format.ts         labels, units, number and pace formatting
  chart.ts          the SVG chart layer (~100 lines, no chart library)
  map.ts            Leaflet routes
  storage.ts        IndexedDB
  dom.ts            $() that throws instead of returning null
  ui/               tiles, charts, bests, table, import — render only
  ingest.ts         the Web Worker: zip → DEFLATE → XML → aggregate
parse_health.py     the same aggregate, from the command line
```

**Rendering.** There is no virtual DOM. Instead, `state.ts` exposes
`subscribe(keys, fn)` and each section registers the state it actually reads.
Picking a workout changes only `sel`, so only the map redraws and two
`aria-selected` attributes flip — the charts and the workout table (thousands of
rows on a multi-year export) are left alone. `browser-test.mjs` asserts this by
tagging a row node and checking it survives the click.

**The data contract.** `Aggregate` in `src/types.ts` is produced by two
independent implementations — `src/ingest.ts` in the browser and
`parse_health.py` on the command line — and `test.mjs` runs both over the same
fixture and diffs the results, so the two cannot drift apart silently.

**Charts.** Hand-rolled SVG: grid, bars (stacked or single), line, min–max band,
crosshair and tooltip. Adding a charting library would have cost more bytes than
the whole chart module.

## Using the Python parser instead

For a very large export, or to pre-render a deployment with data in it:

```bash
unzip export.zip                        # gives you apple_health_export/
python3 parse_health.py apple_health_export/ public/health.json
npm run dev
```

The page loads `health.json` from the site root when one is served alongside it.
`public/health.json` is git-ignored **and** `.vercelignore`d, so a deploy never
carries your data with it — that is deliberate, not an oversight.

## Tests

```bash
npm test              # 45 tests: zip reading, aggregation, GPX, view logic
npm run test:browser  # 7 tests: worker, IndexedDB, drawing, selection, reload
```

`test.mjs` runs in plain Node 23.6+ — it imports the TypeScript sources directly,
via native type stripping, with no build step or test runner. `browser-test.mjs` builds the real bundle, serves it, and drives
headless Chrome over the DevTools protocol; it skips itself when Chrome is absent.

## Deployment

Any static host. The repo is configured for Vercel (`vercel.json`):

Pushes to `main` deploy automatically; pull requests get preview deployments.
To deploy by hand:

```bash
npx vercel --prod
```

`.vercelignore` keeps `apple_health_export/`, `health.json` and the test tooling
out of the deployment.

## Browser support

Chrome, Edge, Firefox and Safari 16.4+ (it needs `DecompressionStream`).
Streams are read with `getReader()` rather than `for await`, because iOS Safari
does not implement async iteration on `ReadableStream`.

## License

MIT
