import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as I from '../public/lib/indicators.js';
import luxalgoStyle from '../custom/luxalgo-style.js';
import majorFvg from '../custom/major-fvg.js';
import { backtest, conditionFn } from '../public/lib/backtest.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
const close = bars.map((b) => b.close);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// Independent, deliberately naive versions of the textbook formulas.
function naiveEma(src, n) {
  const out = []; let prev;
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) { out.push(NaN); continue; }
    if (i === n - 1) { prev = src.slice(0, n).reduce((a, b) => a + b) / n; out.push(prev); continue; }
    prev = (src[i] - prev) * (2 / (n + 1)) + prev; out.push(prev);
  }
  return out;
}
function naiveRsi(src, n) {
  // Wilder's original method: seed with simple averages, then smooth.
  const out = new Array(src.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = src[i] - src[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n; out[n] = 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = 100 - 100 / (1 + g / l);
  }
  return out;
}
function naiveAtr(b, n) {
  const trs = b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  const out = new Array(b.length).fill(NaN);
  let a = trs.slice(0, n).reduce((s, v) => s + v) / n; out[n - 1] = a;
  for (let i = n; i < b.length; i++) { a = (a * (n - 1) + trs[i]) / n; out[i] = a; }
  return out;
}

test('SMA matches a plain average', () => {
  const s = I.sma(close, 20);
  for (const i of [19, 100, 999]) assert.ok(near(s[i], close.slice(i - 19, i + 1).reduce((a, b) => a + b) / 20));
  assert.ok(Number.isNaN(s[18]));
});

test('EMA is seeded with the SMA and matches the textbook recursion', () => {
  const a = I.ema(close, 21), b = naiveEma(close, 21);
  for (const i of [20, 21, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test("RSI matches Wilder's method", () => {
  const a = I.compute('rsi', bars, { length: 14 }).value, b = naiveRsi(close, 14);
  assert.ok(Number.isNaN(a[13]));
  for (const i of [14, 15, 200, 999]) assert.ok(near(a[i], b[i]), `i=${i} ${a[i]} vs ${b[i]}`);
  assert.ok(a.slice(14).every((v) => v >= 0 && v <= 100));
});

test('ATR uses Wilder smoothing', () => {
  const a = I.atr(bars, 14), b = naiveAtr(bars, 14);
  for (const i of [13, 14, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test('MACD line is fast EMA minus slow EMA, histogram is MACD minus signal', () => {
  const m = I.compute('macd', bars);
  const f = naiveEma(close, 12), s = naiveEma(close, 26);
  assert.ok(near(m.macd[999], f[999] - s[999]));
  assert.ok(near(m.hist[999], m.macd[999] - m.signal[999]));
});

test('Bollinger bands use population standard deviation', () => {
  const r = I.compute('bb', bars, { length: 20, mult: 2 });
  const w = close.slice(980, 1000), mean = w.reduce((a, b) => a + b) / 20;
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) ** 2, 0) / 20);
  assert.ok(near(r.basis[999], mean));
  assert.ok(near(r.upper[999], mean + 2 * sd, 1e-5));
});

test('every built-in indicator runs on real data and returns full-length series', () => {
  for (const def of I.INDICATORS) {
    const out = I.compute(def.id, bars);
    for (const o of def.outputs) {
      assert.ok(Array.isArray(out[o.key]), `${def.id}.${o.key} missing`);
      assert.ok(out[o.key].length >= bars.length, `${def.id}.${o.key} too short`);
      const last = out[o.key].slice(0, bars.length).filter((v) => Number.isFinite(v));
      assert.ok(last.length > 0, `${def.id}.${o.key} has no values`);
    }
  }
  assert.ok(I.INDICATORS.length >= 50, `only ${I.INDICATORS.length} indicators`);
});

test('supertrend flips direction and stays on the right side of price', () => {
  const r = I.compute('supertrend', bars);
  const flips = r.direction.filter((d, i) => i && d !== r.direction[i - 1] && Number.isFinite(r.direction[i - 1])).length;
  assert.ok(flips > 3);
  bars.forEach((b, i) => { if (Number.isFinite(r.up[i])) assert.ok(r.up[i] <= b.high * 1.0001); });
});

test('custom indicators can be registered and computed', () => {
  I.registerIndicator({ id: 'custom:test', name: 'Test', calc: (b, p, ta) => ({ value: ta.sma(ta.source(b), 3) }) });
  const v = I.compute('custom:test', bars).value;
  assert.ok(near(v[2], (close[0] + close[1] + close[2]) / 3));
});

// ---------- custom indicator format (docs/custom-indicators.md) ----------
test('the template and the bundled example follow the custom indicator format', async () => {
  const tpl = (await import('../docs/indicator-template.js')).default;
  assert.deepEqual(I.indicatorProblems(tpl), []);
  const ex = (await import('../custom/ema-ribbon-squeeze.js')).default;
  assert.deepEqual(I.indicatorProblems(ex), []);
});

test('the alert example indicator follows the format and an alert on its output fires on its signal bars', async () => {
  const { conditionFn } = await import('../public/lib/backtest.js');
  const ex = (await import('../docs/alert-example.js')).default;
  assert.deepEqual(I.indicatorProblems(ex), []);
  I.registerIndicator({ ...ex, id: 'custom:alert-example' });
  const out = I.compute('custom:alert-example', bars);
  const fired = conditionFn(bars, { sig: { id: 'custom:alert-example', params: {} } })({ left: 'sig.buy', op: '>', right: 0 });
  const signalBars = out.buy.flatMap((v, i) => (v === 1 ? [i] : []));
  assert.ok(signalBars.length > 0, 'the fixture has at least one buy signal');
  assert.deepEqual(bars.flatMap((_, i) => (fired(i) ? [i] : [])), signalBars);
});

test('a malformed custom indicator is refused, with each problem named', () => {
  const good = {
    name: 'Ok',
    inputs: [{ key: 'length', type: 'int', default: 14 }],
    outputs: [{ key: 'value', kind: 'line', color: '#2962ff' }],
    calc: (bars, p, ta) => ({ value: ta.sma(ta.source(bars), p.length) }),
  };
  assert.deepEqual(I.indicatorProblems(good), []);
  const cases = [
    [{ ...good, calc: undefined }, /needs a `calc\(bars, p, ta\)` function/],
    [{ ...good, name: '' }, /needs a `name`/],
    [{ ...good, inputs: [{ key: 'length', type: 'int', default: 2.5 }] }, /input "length": an int input needs a whole-number default/],
    [{ ...good, inputs: [{ key: 'ma', type: 'select', options: ['SMA'], default: 'EMA' }] }, /input "ma": its default must be one of its options/],
    [{ ...good, inputs: [{ key: 'src', type: 'source', default: 'close' }] }, /a source input's key must be "source"/],
    [{ ...good, inputs: [{ key: 'on', type: 'bool', default: true }] }, /`type` must be one of int, float, select, source, time/],
    [{ ...good, outputs: [{ key: 'value', kind: 'area' }] }, /`kind` must be "line" or "histogram"/],
    [{ ...good, outputs: [{ key: 'value', visible: 'false' }] }, /`visible` must be true or false/],
    [{ ...good, outputs: [{ key: 'a' }, { key: 'a' }], calc: (b) => ({ a: b.map(() => 1) }) }, /output "a": the key is used twice/],
    [{ ...good, calc: (bars) => ({ value: bars.slice(1).map((b) => b.close) }) }, /output "value": calc\(\) returned 299 values, but there are 300 bars/],
    [{ ...good, calc: () => ({}) }, /output "value": calc\(\) returned no list for it/],
    [{ ...good, calc: () => { throw new Error('boom'); } }, /calc\(\) stopped with an error on test bars: boom/],
    [{ ...good, calc: (bars) => ({ value: bars.map((b) => b.close), markers: [{ time: bars[0].time, position: 'top', shape: 'arrowUp' }] }) }, /markers: each needs/],
    [{ ...good, levels: ['70'] }, /`levels` must be a list of numbers/],
  ];
  for (const [def, re] of cases) assert.match(I.indicatorProblems(def).join('\n'), re);
  assert.throws(
    () => I.registerIndicator({ ...good, id: 'custom:test-broken', calc: () => ({}) }),
    /doesn't follow the format \(docs\/custom-indicators\.md\):\n- output "value"/,
  );
  assert.equal(I.BY_ID['custom:test-broken'], undefined, 'a refused indicator is not registered');
  assert.equal(I.registerIndicator({ ...good, id: 'custom:test-ok' }).id, 'custom:test-ok');
});

const luxId = 'custom:luxalgo-style';
const luxStrategy = JSON.parse(readFileSync(new URL('../examples/luxalgo-style-strategy.json', import.meta.url), 'utf8'));
function lux(b, params = {}) {
  if (!I.BY_ID[luxId]) I.registerIndicator({ ...luxalgoStyle, id: luxId });
  return I.compute(luxId, b, params);
}

test('LuxAlgo-style indicator follows the format and handles empty, short and flat histories', () => {
  assert.deepEqual(I.indicatorProblems(luxalgoStyle), []);
  for (const n of [0, 1, 9, 10, 49, 50, 300]) {
    const flat = Array.from({ length: n }, (_, i) => ({ time: 1700000000 + i * 86400, open: 10, high: 10, low: 10, close: 10, volume: 0 }));
    const out = lux(flat);
    for (const o of luxalgoStyle.outputs) {
      assert.equal(out[o.key].length, n, `${o.key} at length ${n}`);
      assert.ok(out[o.key].every((v) => Number.isFinite(v) || Number.isNaN(v)), 'no Infinity or undefined');
    }
    assert.ok(out.buy.every((v) => v === 0));
    assert.ok(out.sell.every((v) => v === 0));
    assert.deepEqual(out.markers, []);
    assert.ok(out.direction.slice(0, 9).every(Number.isNaN));
  }
  for (const key of ['buy', 'sell', 'direction']) {
    assert.equal(luxalgoStyle.outputs.find((o) => o.key === key).visible, false);
  }
  for (const params of [{ atrLength: 0 }, { emaLength: 2.5 }, { sensitivity: -1 }, { sensitivity: Infinity }]) {
    assert.throws(() => lux(bars, params), /must be/);
  }
});

test('LuxAlgo-style signals mark reversals once, with correct direction, trails and labels', () => {
  const b = [10, 10, 10, 14, 16, 17, 12, 9, 8, 13, 16, 17].map((close, i) => ({
    time: 1700000000 + i * 86400, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1,
  }));
  const out = lux(b, { atrLength: 2, sensitivity: 1, emaLength: 3, trendFilter: 'Off' });
  assert.deepEqual(out.buy, [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(out.sell, [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(out.direction.slice(1), [-1, -1, 1, 1, 1, -1, -1, -1, 1, 1, 1]);
  assert.equal(out.bullish[3], 11.25, 'ATR trail on the first bullish reversal');
  assert.equal(out.bearish[6], 15.78125, 'ATR trail on the bearish reversal');
  assert.deepEqual(out.markers.map((m) => [m.time, m.position, m.shape, m.text]), [
    [b[3].time, 'belowBar', 'arrowUp', 'Buy'],
    [b[6].time, 'aboveBar', 'arrowDown', 'Sell'],
    [b[9].time, 'belowBar', 'arrowUp', 'Buy'],
  ]);
});

test('LuxAlgo-style EMA filtering skips unconfirmed reversals without delaying signals', () => {
  const unfiltered = lux(bars, { trendFilter: 'Off' });
  const filtered = lux(bars);
  let blocked = 0, allowed = 0;
  for (let i = 0; i < bars.length; i++) {
    for (const key of ['buy', 'sell']) {
      const passes = key === 'buy' ? bars[i].close > filtered.trend[i] : bars[i].close < filtered.trend[i];
      assert.equal(filtered[key][i], unfiltered[key][i] && passes ? 1 : 0, `${key} at ${i}`);
      if (unfiltered[key][i]) passes ? allowed++ : blocked++;
    }
  }
  assert.ok(blocked > 0 && allowed > 0, 'fixture exercises both sides of the filter');
  assert.deepEqual(filtered.direction, unfiltered.direction, 'filter changes entries, not exit direction');
});

test('LuxAlgo-style history is identical when calculated one bar at a time (no look-ahead)', () => {
  const full = lux(bars);
  for (let n = 1; n <= bars.length; n++) {
    const prefix = lux(bars.slice(0, n));
    for (const o of luxalgoStyle.outputs) {
      assert.deepEqual(prefix[o.key], full[o.key].slice(0, n), `${o.key}, prefix ${n}`);
    }
    assert.deepEqual(prefix.markers, full.markers.filter((m) => m.time <= bars[n - 1].time));
  }
});

test('LuxAlgo-style hidden signals work in alert rules and the example strategy fills next-bar open', () => {
  const out = lux(bars);
  for (const key of ['buy', 'sell']) {
    const fired = conditionFn(bars, luxStrategy.indicators)({ left: `lux.${key}`, op: '>', right: 0 });
    assert.deepEqual(bars.map((_, i) => fired(i)), out[key].map(Boolean));
    assert.ok(out[key].some(Boolean), `fixture includes ${key} signals`);
  }
  const result = backtest(bars, luxStrategy);
  assert.ok(result.trades.some((t) => t.side === 'long'));
  assert.ok(result.trades.some((t) => t.side === 'short'));
  assert.ok(Number.isFinite(result.stats.netProfitPct));
  assert.equal(result.equity.length, bars.length);
  for (const trade of result.trades) {
    const i = bars.findIndex((b) => b.time === trade.entryTime);
    assert.equal(out[trade.side === 'long' ? 'buy' : 'sell'][i - 1], 1, 'signal precedes fill');
    const slip = trade.side === 'long' ? 1.0005 : 0.9995;
    assert.ok(near(trade.entryPrice, bars[i].open * slip));
  }
});

test('chart renderer never draws LuxAlgo-style numeric signals on a sub-dollar price scale', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { LightweightCharts: { LineSeries: 'line', HistogramSeries: 'histogram' } };
  try {
    const { ChartPane } = await import('../public/js/chart.js');
    const b = bars.slice(0, 200).map((bar) => ({ ...bar, open: bar.open / 1e6, high: bar.high / 1e6, low: bar.low / 1e6, close: bar.close / 1e6 }));
    const out = lux(b);
    const plotted = [];
    let markers;
    const pane = {
      chart: {
        panes: () => [{ setStretchFactor() {} }],
        addSeries(kind, opts, index) {
          const series = { kind, opts, index, setData(data) { this.data = data; } };
          plotted.push(series);
          return series;
        },
      },
      cfg: { indicators: [{ uid: 'lux', id: luxId, params: {} }], tf: '1m' },
      shown: b, times: b.map((bar) => bar.time), step: 60,
      indSeries: new Map(), extraMarkers: [],
      computeIndicator: () => out,
      toChart: (time) => time,
      markers: { setMarkers(value) { markers = value; } },
    };
    ChartPane.prototype.renderIndicators.call(pane);
    assert.equal(plotted.length, 3, 'only bullish trail, bearish trail and EMA');
    assert.ok(plotted.every((s) => s.kind === 'line' && s.index === 0));
    for (const s of plotted) {
      assert.equal(s.opts.autoscaleInfoProvider(), null, 'overlay does not stretch the candle scale');
      assert.ok(s.data.every((point) => point.value === undefined || point.value > 0 && point.value < 1));
    }
    assert.deepEqual(markers, out.markers, 'buy/sell arrows still draw');
    assert.equal(pane.indResults.lux, out, 'hidden signals remain available for rules and exports');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('LuxAlgo-style signal fallback is transparent even when legacy renderers ignore output visibility', () => {
  const out = lux(bars);
  for (const key of ['buy', 'sell', 'direction']) {
    const def = luxalgoStyle.outputs.find((o) => o.key === key);
    assert.equal(def.kind, 'histogram', 'legacy histogram renderer uses per-point colors');
    assert.equal(def.color, '#00000000');
    assert.equal(def.visible, false);
  }
  assert.equal(out.colors.length, bars.length);
  assert.ok(out.colors.every((color) => color === 'rgba(0,0,0,0)'));
  assert.ok(out.buy.some((v) => v === 1) && out.sell.some((v) => v === 1), 'numeric rules still work');
});

const fvgParams = Object.fromEntries(majorFvg.inputs.map((input) => [input.key, input.default]));
const fvg = (b, params = {}) => majorFvg.calc(b, { ...fvgParams, atrLength: 2, minGapAtr: 0.2, minBodyAtr: 0.5, ...params }, I.ta);
const fvgBar = (i, open, high, low, close) => ({ time: 1700000000 + i * 60, open, high, low, close, volume: 100 });
const gapBars = [fvgBar(0, 10, 10.5, 9.5, 10), fvgBar(1, 10, 14.5, 10, 14), fvgBar(2, 14, 15.5, 14, 15), fvgBar(3, 15, 15.5, 14.5, 15)];

test('major FVGs follow the format, confirm three candles and ignore the unfinished candle', () => {
  assert.deepEqual(I.indicatorProblems(majorFvg), []);
  assert.deepEqual(fvg(gapBars.slice(0, 3)).fvgZones, [], 'third candle still forming');
  const out = fvg(gapBars);
  assert.equal(out.value.length, gapBars.length);
  assert.equal(out.fvgZones.length, 1);
  const zone = out.fvgZones[0];
  assert.equal(zone.side, 'bullish');
  assert.equal(zone.lower, 10.5);
  assert.equal(zone.upper, 14);
  assert.equal(zone.created, gapBars[2].time);
  assert.equal(zone.touched, false);
  assert.ok(near(zone.atrSize, 3.5 / 2.75));
  const forming = [...gapBars.slice(0, 3), fvgBar(3, 15, 16, 1, 2)];
  assert.deepEqual(fvg(forming).fvgZones, out.fvgZones, 'unfinished wick cannot create or mitigate a confirmed zone');
  for (const n of [0, 1, 2]) assert.deepEqual(fvg(gapBars.slice(0, n)).fvgZones, []);
});

test('major FVGs shrink on partial fills and disappear on complete fills, symmetrically', () => {
  const partial = [...gapBars.slice(0, 3), fvgBar(3, 15, 15, 12, 13), fvgBar(4, 13, 14, 12.5, 13)];
  const zone = fvg(partial).fvgZones.find((z) => z.side === 'bullish');
  assert.equal(zone.upper, 12);
  assert.equal(zone.lower, 10.5);
  assert.equal(zone.originalUpper, 14);
  assert.equal(zone.touched, true);
  const filled = [...partial.slice(0, 4), fvgBar(4, 13, 13, 10, 11), fvgBar(5, 11, 12, 10.5, 11)];
  assert.ok(!fvg(filled).fvgZones.some((z) => z.created === gapBars[2].time));
  const mirror = (b) => b.map((x) => ({ ...x, open: 20 - x.open, high: 20 - x.low, low: 20 - x.high, close: 20 - x.close }));
  const bear = fvg(mirror(gapBars)).fvgZones[0];
  assert.equal(bear.side, 'bearish');
  assert.equal(bear.lower, 6);
  assert.equal(bear.upper, 9.5);
  assert.equal(fvg(mirror(partial)).fvgZones.find((z) => z.side === 'bearish').lower, 8);
  assert.ok(!fvg(mirror(filled)).fvgZones.some((z) => z.created === gapBars[2].time));
});

test('major FVG filters reject small gaps and weak displacement without emitting price-scale values', () => {
  assert.deepEqual(fvg(gapBars, { minGapAtr: 10 }).fvgZones, []);
  assert.deepEqual(fvg(gapBars, { minBodyAtr: 10 }).fvgZones, []);
  const out = fvg(bars);
  assert.ok(out.value.every(Number.isNaN), 'no numeric plots stretch the scale');
  assert.ok(out.fvgZones.filter((z) => z.side === 'bullish').length <= 2);
  assert.ok(out.fvgZones.filter((z) => z.side === 'bearish').length <= 2);
  assert.ok(out.fvgZones.every((z) => z.lower < z.upper && z.created < bars.at(-1).time));
});

test('FVG rectangles stay attached to price and new-zone labels fit inside the chart', async () => {
  const { FvgZones } = await import('../public/js/fvg-zones.js');
  const rectangles = [], texts = [];
  const ctx = {
    save() {}, restore() {}, setLineDash() {}, strokeRect() {},
    measureText: (text) => ({ width: text.length * 5 }),
    fillRect: (...args) => rectangles.push(args),
    fillText: (...args) => texts.push(args),
  };
  const pane = { shown: gapBars, chart: { timeScale: () => ({ logicalToCoordinate: () => 295 }) } };
  const primitive = new FvgZones(pane, fvg(gapBars).fvgZones);
  primitive.attached({ series: { priceToCoordinate: (price) => (20 - price) * 10 } });
  primitive.draw({ context: ctx, mediaSize: { width: 300, height: 200 } });
  assert.deepEqual(rectangles[0], [295, 60, 5, 35], 'rectangle matches gap bounds, not 0/1 signal values');
  assert.equal(texts.length, 1);
  assert.ok(texts[0][1] + ctx.measureText(texts[0][0]).width <= 300, 'right-edge labels are not clipped');
  primitive.detached();
  primitive.draw({ context: ctx, mediaSize: { width: 300, height: 200 } });
  assert.equal(texts.length, 1, 'detached primitives stop drawing');
});
