import { escapeXmlText } from "../element-text.js";
import { formatSvgNumber } from "../svg-number.js";
import { DEFAULT_FONT_FAMILY } from "../default-font.js";
import type { ChartModel, ChartPalette, ChartSeries } from "./model.js";

/**
 * `renderChartSvg(model) => string`: the ONE place a chart's pixels get
 * computed (plan §4.1 — the embedded `<svg>` and a standalone-opened chart
 * SVG are the same bytes). Geometry is carried over from the prototype's
 * `chartSvg` (`docs/design/prototype/comotion-logic-v3.js:228-257`),
 * extended with the dual-axis and stacked modes the prototype never had.
 *
 * Three hard rules the output must never break (plan §4.1):
 *   1. no `id` attribute anywhere (`element-clipboard.ts`'s `regenerateIds`
 *      does not recurse into an embedded `<svg>`, so a duplicate id would
 *      survive copy/paste);
 *   2. no `<style>`, class, `<defs>`, gradients, SMIL or CSS animation —
 *      every visual property is a presentation ATTRIBUTE;
 *   3. every number goes through `formatSvgNumber`.
 *
 * No `node:` imports — this runs in the browser for local preview too
 * (`chart/edit.ts`'s `previewChartModel`).
 */

/**
 * The six hex swatches per palette — MUST stay byte-for-byte identical to
 * `packages/web/src/styles/tokens.css`'s `--accent-palette-{brand,cool,warm}-{1..6}`
 * (design doc `01-DESIGN_TOKENS.md`'s `accent.palette.*` row): the renderer
 * writes plain hex (design-contract.test.ts forbids literal hex in
 * `packages/web/src`, so the CSS vars exist only for the GUI's own palette
 * swatches, e.g. the insert panel/data window pickers), while this constant
 * is what actually lands in a chart's pixels — two independent sources of
 * truth for the same six colours, pinned equal by
 * `packages/web/test/tokens.test.ts`'s "PALETTES 與 tokens.css 一致" test.
 * Exported (not module-private) so that test can import it.
 */
export const CHART_PALETTE_HEX: Readonly<Record<ChartPalette, readonly string[]>> = {
  brand: ["#C8233B", "#5B6DEA", "#4A8F45", "#E08A2E", "#2B9E75", "#A9B0B8"],
  cool: ["#5B6DEA", "#2B9E75", "#38BDF8", "#A78BFA", "#22C55E", "#94A3B8"],
  warm: ["#C8233B", "#E08A2E", "#F4C542", "#D9634C", "#B45309", "#A9B0B8"],
};
const PALETTES = CHART_PALETTE_HEX;

const MUTED = "#a9b0b8";
const INK = "#e7e9ee";
const GRID_COLOR = "rgba(255,255,255,.35)";
const ZERO_LINE_COLOR = "rgba(255,255,255,.5)";

const n = formatSvgNumber;
const esc = escapeXmlText;

interface ResolvedSeries extends ChartSeries {
  color: string;
}

function tickLabel(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function domainOf(list: readonly ResolvedSeries[], stacked: boolean): { min: number; max: number; span: number } {
  if (list.length === 0) return { min: 0, max: 1, span: 1 };
  if (stacked) {
    let max = 0;
    let min = 0;
    const count = list[0].values.length;
    for (let i = 0; i < count; i++) {
      let pos = 0;
      let neg = 0;
      for (const series of list) {
        const value = series.values[i] ?? 0;
        if (value >= 0) pos += value;
        else neg += value;
      }
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    }
    max = Math.max(1, max);
    return { min, max, span: max - min || 1 };
  }
  const all = list.flatMap((series) => series.values);
  const min = Math.min(0, ...all);
  const max = Math.max(1, ...all);
  return { min, max, span: max - min || 1 };
}

export function renderChartSvg(model: ChartModel): string {
  const W = model.width;
  const H = model.height;
  const palette = PALETTES[model.palette];
  const cats = model.categories;
  const count = cats.length;
  const series: ResolvedSeries[] = model.series.map((s, i) => ({
    ...s,
    color: s.color ?? palette[i % palette.length],
  }));

  const legendBottomHeight = model.legend === "bottom" ? 26 : 0;
  const legendRightWidth = model.legend === "right" ? 118 : 0;
  const hasRightAxis = model.axes === "dual";
  const padL = model.yTitle ? 60 : 44;
  const padR = (hasRightAxis ? 44 : 14) + legendRightWidth;
  const padB = (model.xTitle ? 42 : 26) + legendBottomHeight;
  const padT = 14;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  const isPie = model.type === "pie" || model.type === "donut";
  const legendItems = isPie
    ? cats.map((label, i) => ({ label, color: palette[i % palette.length] }))
    : series.map((s) => ({ label: s.name, color: s.color }));

  const legendMarkup = (): string => {
    if (model.legend === "none") return "";
    let g = "";
    if (model.legend === "bottom") {
      let x = padL;
      for (const item of legendItems) {
        g +=
          `<rect x="${n(x)}" y="${n(H - 16)}" width="10" height="10" rx="2" fill="${item.color}"/>` +
          `<text x="${n(x + 14)}" y="${n(H - 7.5)}" font-size="10" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(item.label)}</text>`;
        x += 14 + item.label.length * 6.2 + 16;
      }
    } else {
      legendItems.forEach((item, i) => {
        const y = padT + 6 + i * 18;
        g +=
          `<rect x="${n(W - legendRightWidth + 8)}" y="${n(y)}" width="10" height="10" rx="2" fill="${item.color}"/>` +
          `<text x="${n(W - legendRightWidth + 22)}" y="${n(y + 8.5)}" font-size="10" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(item.label)}</text>`;
      });
    }
    return g;
  };

  const titlesMarkup = (): string => {
    let g = "";
    if (model.xTitle) {
      g += `<text x="${n(padL + pw / 2)}" y="${n(H - legendBottomHeight - 6)}" font-size="10" font-weight="700" text-anchor="middle" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(model.xTitle.toUpperCase())}</text>`;
    }
    if (model.yTitle) {
      g += `<text transform="translate(${n(12)} ${n(padT + ph / 2)}) rotate(-90)" font-size="10" font-weight="700" text-anchor="middle" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(model.yTitle.toUpperCase())}</text>`;
    }
    return g;
  };

  // A full-viewport transparent rect leads every chart. Without it the
  // embedded <svg> paints only strokes, glyphs and bars, so (a) a click on
  // the chart's padding or the gap between bars falls through to the slide
  // <svg> and deselects, and (b) the browser's getBoundingClientRect() —
  // the selection outline — is the union of painted content, not the
  // W×H viewport that core's `primitiveBounds` ("svg" case) reports. The
  // rect makes both the hit area and the outline exactly W×H.
  const hitArea = `<rect x="0" y="0" width="${n(W)}" height="${n(H)}" fill="transparent"/>`;
  const wrap = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}">${hitArea}${body}</svg>`;

  if (isPie) {
    let body = "";
    const values = series[0] ? series[0].values : [];
    const total = values.reduce((sum, v) => sum + v, 0) || 1;
    const cx = padL + pw / 2;
    const cy = padT + ph / 2;
    const r = Math.min(pw, ph) / 2 - 6;
    const ri = model.type === "donut" ? r * 0.55 : 0;
    let angle = -Math.PI / 2;
    values.forEach((value, i) => {
      const nextAngle = angle + (value / total) * Math.PI * 2;
      const large = nextAngle - angle > Math.PI ? 1 : 0;
      const point = (a: number, radius: number) => `${n(cx + radius * Math.cos(a))} ${n(cy + radius * Math.sin(a))}`;
      const d = ri
        ? `M${point(angle, r)} A${n(r)} ${n(r)} 0 ${large} 1 ${point(nextAngle, r)} L${point(nextAngle, ri)} A${n(ri)} ${n(ri)} 0 ${large} 0 ${point(angle, ri)} Z`
        : `M${n(cx)} ${n(cy)} L${point(angle, r)} A${n(r)} ${n(r)} 0 ${large} 1 ${point(nextAngle, r)} Z`;
      body += `<path d="${d}" fill="${palette[i % palette.length]}"/>`;
      if (model.labels && value / total > 0.04) {
        const mid = (angle + nextAngle) / 2;
        const rMid = ri ? (r + ri) / 2 : r * 0.65;
        body += `<text x="${n(cx + rMid * Math.cos(mid))}" y="${n(cy + rMid * Math.sin(mid) + 3.5)}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff" font-family="${DEFAULT_FONT_FAMILY}">${Math.round((value / total) * 100)}%</text>`;
      }
      angle = nextAngle;
    });
    if (ri) {
      body += `<text x="${n(cx)}" y="${n(cy + 5)}" font-size="14" font-weight="800" text-anchor="middle" fill="${INK}" font-family="${DEFAULT_FONT_FAMILY}">${n(total)}</text>`;
    }
    return wrap(body + legendMarkup());
  }

  const horiz = model.type === "hbar";
  const leftSeries = series.filter((s) => !(hasRightAxis && s.axis === "right"));
  const rightSeries = hasRightAxis ? series.filter((s) => s.axis === "right") : [];
  const leftDomain = domainOf(leftSeries, model.stacked);
  const rightDomain = hasRightAxis ? domainOf(rightSeries, false) : leftDomain;

  const gw = (horiz ? ph : pw) / count;
  const X = (i: number) => padL + (i + 0.5) * gw;
  const YC = (i: number) => padT + (i + 0.5) * gw;
  const Yof = (domain: typeof leftDomain) => (v: number) => padT + ph - ((v - domain.min) / domain.span) * ph;
  const XVof = (domain: typeof leftDomain) => (v: number) => padL + ((v - domain.min) / domain.span) * pw;
  const Yleft = Yof(leftDomain);
  const Yright = Yof(rightDomain);
  const XVleft = XVof(leftDomain);
  const XVright = XVof(rightDomain);
  const yFor = (s: ResolvedSeries) => (hasRightAxis && s.axis === "right" ? Yright : Yleft);
  const xvFor = (s: ResolvedSeries) => (hasRightAxis && s.axis === "right" ? XVright : XVleft);

  let body = "";
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = leftDomain.min + (leftDomain.span * t) / ticks;
    if (horiz) {
      const x = XVleft(v);
      if (model.grid) body += `<line x1="${n(x)}" y1="${n(padT)}" x2="${n(x)}" y2="${n(padT + ph)}" stroke="${GRID_COLOR}" stroke-dasharray="3 4"/>`;
      body += `<text x="${n(x)}" y="${n(padT + ph + 14)}" font-size="9.5" text-anchor="middle" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${tickLabel(v)}</text>`;
    } else {
      const y = Yleft(v);
      if (model.grid) body += `<line x1="${n(padL)}" y1="${n(y)}" x2="${n(padL + pw)}" y2="${n(y)}" stroke="${GRID_COLOR}" stroke-dasharray="3 4"/>`;
      body += `<text x="${n(padL - 8)}" y="${n(y + 3.5)}" font-size="9.5" text-anchor="end" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${tickLabel(v)}</text>`;
    }
  }
  if (hasRightAxis) {
    for (let t = 0; t <= ticks; t++) {
      const v = rightDomain.min + (rightDomain.span * t) / ticks;
      if (horiz) {
        const x = XVright(v);
        body += `<text x="${n(x)}" y="${n(padT - 4)}" font-size="9.5" text-anchor="middle" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${tickLabel(v)}</text>`;
      } else {
        const y = Yright(v);
        body += `<text x="${n(padL + pw + 8)}" y="${n(y + 3.5)}" font-size="9.5" text-anchor="start" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${tickLabel(v)}</text>`;
      }
    }
  }

  body += horiz
    ? `<line x1="${n(padL)}" y1="${n(padT)}" x2="${n(padL)}" y2="${n(padT + ph)}" stroke="${ZERO_LINE_COLOR}"/>`
    : `<line x1="${n(padL)}" y1="${n(Yleft(0))}" x2="${n(padL + pw)}" y2="${n(Yleft(0))}" stroke="${ZERO_LINE_COLOR}"/>`;

  cats.forEach((c, i) => {
    body += horiz
      ? `<text x="${n(padL - 8)}" y="${n(YC(i) + 3.5)}" font-size="10" text-anchor="end" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(c)}</text>`
      : `<text x="${n(X(i))}" y="${n(padT + ph + 14)}" font-size="10" text-anchor="middle" fill="${MUTED}" font-family="${DEFAULT_FONT_FAMILY}">${esc(c)}</text>`;
  });

  if (model.stacked && (model.type === "bar" || model.type === "hbar")) {
    const barWidth = gw * 0.6;
    const posAcc = new Array<number>(count).fill(0);
    const negAcc = new Array<number>(count).fill(0);
    for (const s of series) {
      for (let i = 0; i < count; i++) {
        const value = s.values[i];
        const stackBottom = value >= 0 ? posAcc[i] : negAcc[i];
        const stackTop = stackBottom + value;
        if (horiz) {
          const x0 = XVleft(Math.min(stackBottom, stackTop));
          const x1 = XVleft(Math.max(stackBottom, stackTop));
          const y = YC(i) - barWidth / 2;
          body += `<rect x="${n(x0)}" y="${n(y)}" width="${n(x1 - x0)}" height="${n(barWidth)}" fill="${s.color}"/>`;
        } else {
          const y0 = Yleft(Math.max(stackBottom, stackTop));
          const y1 = Yleft(Math.min(stackBottom, stackTop));
          const x = X(i) - barWidth / 2;
          body += `<rect x="${n(x)}" y="${n(y0)}" width="${n(barWidth)}" height="${n(y1 - y0)}" fill="${s.color}"/>`;
        }
        if (value >= 0) posAcc[i] = stackTop;
        else negAcc[i] = stackTop;
      }
    }
  } else if (model.type === "bar" || horiz) {
    const barWidth = (gw * 0.68) / series.length;
    series.forEach((s, si) => {
      cats.forEach((_, i) => {
        const value = s.values[i];
        const y = yFor(s);
        const xv = xvFor(s);
        if (horiz) {
          const top = YC(i) - gw * 0.34 + si * barWidth;
          const x0 = xv(Math.min(0, value));
          const width = Math.abs(xv(value) - xv(0));
          body += `<rect x="${n(x0)}" y="${n(top)}" width="${n(width)}" height="${n(barWidth - 2)}" rx="2" fill="${s.color}"/>`;
          if (model.labels) {
            body += `<text x="${n(xv(value) + 5)}" y="${n(top + barWidth / 2 + 2.5)}" font-size="9.5" font-weight="700" fill="${INK}" font-family="${DEFAULT_FONT_FAMILY}">${esc(String(value))}</text>`;
          }
        } else {
          const left = X(i) - gw * 0.34 + si * barWidth;
          const top = y(Math.max(0, value));
          const height = Math.abs(y(value) - y(0));
          body += `<rect x="${n(left)}" y="${n(top)}" width="${n(barWidth - 2)}" height="${n(height)}" rx="2" fill="${s.color}"/>`;
          if (model.labels) {
            body += `<text x="${n(left + (barWidth - 2) / 2)}" y="${n(top - 5)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${INK}" font-family="${DEFAULT_FONT_FAMILY}">${esc(String(value))}</text>`;
          }
        }
      });
    });
  } else {
    series.forEach((s) => {
      const y = yFor(s);
      const points = cats.map((_, i) => [X(i), y(s.values[i])] as const);
      const line = points.map(([px, py]) => `${n(px)},${n(py)}`).join(" ");
      if (model.type === "area") {
        body += `<polygon points="${n(X(0))},${n(y(0))} ${line} ${n(X(count - 1))},${n(y(0))}" fill="${s.color}" fill-opacity=".22"/>`;
      }
      body += `<polyline points="${line}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      points.forEach(([px, py], i) => {
        body += `<circle cx="${n(px)}" cy="${n(py)}" r="3.5" fill="${s.color}"/>`;
        if (model.labels) {
          body += `<text x="${n(px)}" y="${n(py - 9)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${INK}" font-family="${DEFAULT_FONT_FAMILY}">${esc(String(s.values[i]))}</text>`;
        }
      });
    });
  }

  return wrap(body + titlesMarkup() + legendMarkup());
}
