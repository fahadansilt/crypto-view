import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as I from '../public/lib/indicators.js';
import luxalgoStyle from '../custom/luxalgo-style.js';
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
