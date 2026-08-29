import type { Bucket } from './data.ts';
import { esc, fmt } from './format.ts';

const W = 1000, H = 300, PAD = { t: 12, r: 12, b: 26, l: 52 };

export function niceTicks(max: number, count = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find(m => m * mag >= raw) as number) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  if ((out[out.length - 1] as number) < max) out.push((out[out.length - 1] as number) + step);
  return out;
}

export function xLabel(k: string, mode: Bucket): string {
  const d = new Date((mode === 'month' ? k + '-01' : k) + 'T00:00:00Z');
  return mode === 'day'
    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export interface DrawOptions<P> {
  mode: Bucket;
  aria?: string;
  empty?: string;
  /** Highest value this point contributes, used to scale the y axis. */
  max: (d: P) => number;
  bars?: boolean;
  stacked?: boolean;
  val?: (d: P) => number;
  band?: boolean;
  line?: ((d: P) => number) | null;
  lineSlot?: number;
  tip: (d: P) => string;
}

/** Bars (stacked or single) and/or a line with an optional min–max band. */
export function draw<P extends { k: string; parts?: number[]; lo?: number; hi?: number }>(
  host: HTMLElement, pts: P[], o: DrawOptions<P>,
): void {
  if (!pts.length) {
    host.innerHTML = `<p class="sub">${esc(o.empty || 'No data in this range.')}</p>`;
    return;
  }
  const max = Math.max(...pts.map(o.max), 0) || 1;
  const ticks = niceTicks(max), top = ticks[ticks.length - 1] as number;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (pts.length === 1 ? iw / 2 : (iw * i) / (pts.length - 1));
  const y = (v: number) => PAD.t + ih * (1 - v / top);
  const bw = Math.max(1, Math.min(24, iw / pts.length - (pts.length > 120 ? 0.5 : 2)));
  const p: string[] = [];

  p.push(ticks.map(t => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/>`
    + `<text x="${PAD.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${fmt(t)}</text>`).join(''));

  if (o.band) {
    p.push(`<path d="${pts.map((d, i) => `${i ? 'L' : 'M'}${x(i)} ${y(d.hi as number)}`).join('')}`
      + `${pts.slice().reverse().map((d, i) => `L${x(pts.length - 1 - i)} ${y(d.lo as number)}`).join('')}Z" fill="var(--band)"/>`);
  }

  if (o.bars) {
    const rx = Math.min(4, bw / 2);
    pts.forEach((d, i) => {
      let base = 0;
      (o.stacked ? (d.parts as number[]) : [o.val!(d)]).forEach((v, s) => {
        if (!(v > 0)) return;
        const h = ih * v / top, gap = o.stacked && base > 0 ? 2 : 0;
        p.push(`<rect x="${x(i) - bw / 2}" y="${y(base + v)}" width="${bw}" height="${Math.max(0.5, h - gap)}" rx="${rx}" fill="var(--series-${s + 1})"/>`);
        base += v;
      });
    });
  }
  if (o.line) {
    p.push(`<path fill="none" stroke="var(--series-${o.lineSlot || 1})" stroke-width="2" stroke-linejoin="round"`
      + ` d="${pts.map((d, i) => `${i ? 'L' : 'M'}${x(i)} ${y(o.line!(d))}`).join('')}"/>`);
  }

  const step = Math.max(1, Math.ceil(pts.length / 7));
  pts.forEach((d, i) => {
    if (i % step === 0) {
      p.push(`<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${esc(xLabel(d.k, o.mode))}</text>`);
    }
  });
  p.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>`);
  p.push(`<line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${PAD.t + ih}" stroke="var(--text-muted)" stroke-dasharray="3 3" opacity="0"/>`);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || '')}">${p.join('')}</svg><div class="tip"></div>`;

  // hover: crosshair + tooltip
  const svg = host.querySelector('svg') as SVGSVGElement;
  const tip = host.querySelector('.tip') as HTMLElement;
  const cross = svg.querySelector('.cross') as SVGLineElement;
  svg.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round((px - PAD.l) / (iw / Math.max(1, pts.length - 1)));
    i = Math.max(0, Math.min(pts.length - 1, i));
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('opacity', '1');
    tip.innerHTML = o.tip(pts[i] as P);
    tip.style.opacity = '1';
    const left = (x(i) / W) * r.width;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left - tip.offsetWidth / 2)) + 'px';
    tip.style.top = '4px';
  });
  svg.addEventListener('pointerleave', () => {
    tip.style.opacity = '0';
    cross.setAttribute('opacity', '0');
  });
}
