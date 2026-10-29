// Confirmed three-candle imbalances. Display only: these zones are not trade signals.
export default {
  name: 'Major FVG zones',
  overlay: true,
  noAutoscale: true,
  inputs: [
    { key: 'atrLength', label: 'ATR length', type: 'int', default: 14, min: 1 },
    { key: 'minGapAtr', label: 'Minimum gap size (ATR)', type: 'float', default: 0.5, min: 0 },
    { key: 'minBodyAtr', label: 'Middle candle body (ATR)', type: 'float', default: 1, min: 0 },
    { key: 'lookback', label: 'Lookback bars', type: 'int', default: 1000, min: 3 },
    { key: 'zonesPerSide', label: 'Nearest zones per side', type: 'int', default: 2, min: 1, max: 5 },
  ],
  // Geometry is drawn as shaded price zones, not numeric chart series.
  outputs: [{ key: 'value', label: 'FVG zones', color: '#00000000', visible: false }],
  calc(bars, p, ta) {
    for (const key of ['atrLength', 'lookback', 'zonesPerSide']) {
      if (!Number.isInteger(p[key]) || p[key] < 1) throw new Error(`${key} must be a positive integer`);
    }
    for (const key of ['minGapAtr', 'minBodyAtr']) {
      if (!Number.isFinite(p[key]) || p[key] < 0) throw new Error(`${key} must be non-negative`);
    }
    const value = new Array(bars.length).fill(NaN);
    const atr = ta.atr(bars, p.atrLength);
    let active = [];
    // Always exclude the newest bar: it may still be forming. This also makes
    // replay conservative by one bar, rather than inventing a confirmed gap early.
    const end = bars.length - 1;
    for (let i = Math.max(2, end - p.lookback); i < end; i++) {
      const bar = bars[i];
      active = active.filter((zone) => {
        if (zone.side === 'bullish') {
          if (bar.low <= zone.lower) return false;
          if (bar.low < zone.upper) { zone.upper = bar.low; zone.touched = true; }
        } else {
          if (bar.high >= zone.upper) return false;
          if (bar.high > zone.lower) { zone.lower = bar.high; zone.touched = true; }
        }
        return true;
      });
      const a = atr[i - 1];
      if (!(a > 0) || Math.abs(bars[i - 1].close - bars[i - 1].open) < a * p.minBodyAtr) continue;
      let side, lower, upper;
      if (bar.low > bars[i - 2].high) {
        side = 'bullish'; lower = bars[i - 2].high; upper = bar.low;
      } else if (bar.high < bars[i - 2].low) {
        side = 'bearish'; lower = bar.high; upper = bars[i - 2].low;
      } else continue;
      if (upper - lower < a * p.minGapAtr) continue;
      active.push({ side, lower, upper, originalLower: lower, originalUpper: upper, created: bar.time, atrSize: (upper - lower) / a, touched: false });
    }
    const price = bars[end - 1]?.close;
    const distance = (z) => Math.max(z.lower - price, price - z.upper, 0);
    const fvgZones = ['bullish', 'bearish'].flatMap((side) => active
      .filter((z) => z.side === side)
      .sort((a, b) => distance(a) - distance(b) || b.atrSize - a.atrSize)
      .slice(0, p.zonesPerSide));
    return { value, fvgZones };
  },
};
