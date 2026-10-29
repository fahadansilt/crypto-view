#!/usr/bin/env node
// Reproducible research, not a trading signal. Downloads closed Binance spot 1m bars.
// node scripts/evaluate-pha.js [--refresh] [--days=60]
// The preset is fixed before evaluation; no settings are picked on the holdout.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_STRATEGIES, backtest } from '../public/lib/backtest.js';
import { quantChecks } from '../public/lib/quant.js';
import { registerIndicator } from '../public/lib/indicators.js';
import lux from '../custom/luxalgo-style.js';

const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || 60);
if (!Number.isInteger(days) || days < 10 || days > 180) throw new Error('--days must be an integer from 10 to 180');
const cache = new URL(`../data/pha-1m-${days}d.json`, import.meta.url);
const reportFile = new URL('../data/pha-strategy-evaluation.json', import.meta.url);
const host = 'https://api.binance.com';
async function get(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(host + path, { signal: AbortSignal.timeout(30000) });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) throw new Error(`Binance ${response.status}: ${await response.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error('Binance remained unavailable after three attempts');
}

let dataset;
if (fs.existsSync(cache) && !process.argv.includes('--refresh')) {
  dataset = JSON.parse(fs.readFileSync(cache, 'utf8'));
} else {
  const { serverTime } = await get('/api/v3/time');
  const end = Math.floor(serverTime / 60000) * 60000;
  const start = end - days * 86400000;
  const windows = [];
  for (let from = start; from < end; from += 1000 * 60000) windows.push(from);
  const rows = [];
  for (let i = 0; i < windows.length; i += 4) {
    const pages = await Promise.all(windows.slice(i, i + 4).map((from) => get(`/api/v3/klines?symbol=PHAUSDT&interval=1m&startTime=${from}&endTime=${Math.min(end, from + 1000 * 60000) - 1}&limit=1000`)));
    rows.push(...pages.flat());
    console.error(`Downloaded ${rows.length} closed PHAUSDT candles`);
  }
  dataset = {
    source: `${host}/api/v3/klines`, symbol: 'BINANCE:PHAUSDT', timeframe: '1m',
    fetchedAt: new Date().toISOString(),
    candles: rows.map((r) => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })),
  };
  fs.writeFileSync(cache, JSON.stringify(dataset));
}
const bars = dataset.candles;
if (bars.length !== days * 1440) throw new Error(`Expected ${days * 1440} candles, got ${bars.length}`);
for (let i = 0; i < bars.length; i++) {
  const b = bars[i];
  if (![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) throw new Error(`Invalid candle ${i}`);
  if (i && b.time - bars[i - 1].time !== 60) throw new Error(`Missing or duplicate minute at ${i}`);
}
registerIndicator({ ...lux, id: 'custom:luxalgo-style' });
const preset = EXAMPLE_STRATEGIES['PHA 1m trend filter (experimental)'];
const baseline = JSON.parse(fs.readFileSync(new URL('../examples/luxalgo-style-strategy.json', import.meta.url), 'utf8'));
// Apply the same conservative spread to the baseline for a fair cost comparison.
baseline.spreadPct = preset.spreadPct;
const cuts = [0, Math.floor(bars.length * 0.6), Math.floor(bars.length * 0.8), bars.length];
const windows = ['development', 'validation', 'holdout'].map((name, i) => ({ name, bars: bars.slice(cuts[i], cuts[i + 1]) }));
const evaluate = (strategy, b) => ({
  from: new Date(b[0].time * 1000).toISOString(), to: new Date(b.at(-1).time * 1000).toISOString(),
  bars: b.length, ...backtest(b, strategy).stats,
});
const segments = windows.map((w) => ({ name: w.name, candidate: evaluate(preset, w.bars), baseline: evaluate(baseline, w.bars) }));
// Each segment starts flat and performs its own indicator warm-up. No positions cross boundaries.
const checks = quantChecks(windows[0].bars, preset);
const holdout = segments.at(-1).candidate;
const spread = await get('/api/v3/ticker/bookTicker?symbol=PHAUSDT');
const bid = +spread.bidPrice, ask = +spread.askPrice;
const report = {
  source: dataset.source, symbol: dataset.symbol, timeframe: dataset.timeframe, fetchedAt: dataset.fetchedAt,
  datasetSha256: createHash('sha256').update(JSON.stringify(bars)).digest('hex'),
  bars: bars.length, strategy: preset, strategyDesigns: 1, developmentSensitivityVariants: checks.trials,
  observedSpreadPct: 100 * (ask - bid) / ((ask + bid) / 2),
  assumptions: ['Spot, long-only, no leverage', 'Closed candles only; next-bar-open execution', '0.1% fee + 0.05% slippage per side; 0.25% bid/ask spread', '25% of equity allocated; 1% price stop, 2% price target, 120-bar time exit', 'Frozen preset; 60/20/20 chronological split, each starting flat with fresh warm-up', 'Quant sensitivity checks use development data only; holdout not used to tune settings'],
  segments, full: evaluate(preset, bars), developmentChecks: checks,
  status: holdout.totalTrades >= 30 && holdout.netProfitPct > 0 && checks.gates.every((g) => g.pass) ? 'passed-screening-not-proof-of-future-profit' : 'experimental-not-validated',
};
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error(`Saved report: ${fileURLToPath(reportFile)}`);
