// Original LuxAlgo-style trend signals, not LuxAlgo's proprietary indicator.
// Uses only current/past bars. Signals on an unfinished candle can change;
// use oncePerBarClose alerts and next-bar-open strategy fills.
export default {
  name: 'LuxAlgo-style trend signals',
  overlay: true,
  // Also protects the candle scale if this mounted file reaches an older Docker renderer.
  noAutoscale: true,
  inputs: [
    { key: 'atrLength', label: 'ATR length', type: 'int', default: 10, min: 1 },
    { key: 'sensitivity', label: 'ATR multiplier (higher = fewer flips)', type: 'float', default: 3, min: 0.1 },
    { key: 'trendFilter', label: 'EMA trend filter', type: 'select', options: ['On', 'Off'], default: 'On' },
    { key: 'emaLength', label: 'Trend EMA length', type: 'int', default: 50, min: 1 },
  ],
  outputs: [
    { key: 'bullish', label: 'Bullish trail', kind: 'line', color: '#26a69a', lineWidth: 2 },
    { key: 'bearish', label: 'Bearish trail', kind: 'line', color: '#ef5350', lineWidth: 2 },
    { key: 'trend', label: 'Trend EMA', kind: 'line', color: '#ffb74d' },
    // Transparent histograms are a fallback for older renderers that ignore visible:false.
    { key: 'buy', label: 'Buy signal', kind: 'histogram', color: '#00000000', visible: false },
    { key: 'sell', label: 'Sell signal', kind: 'histogram', color: '#00000000', visible: false },
    { key: 'direction', label: 'Direction (+1 bullish / -1 bearish)', kind: 'histogram', color: '#00000000', visible: false },
  ],
  calc(bars, p, ta) {
    for (const key of ['atrLength', 'emaLength']) {
      if (!Number.isInteger(p[key]) || p[key] < 1) throw new Error(`${key} must be a positive integer`);
    }
    if (!Number.isFinite(p.sensitivity) || p.sensitivity <= 0) throw new Error('sensitivity must be positive');
    const close = ta.source(bars, 'close');
    const st = ta.compute('supertrend', bars, { atrLength: p.atrLength, factor: p.sensitivity });
    const trend = ta.ema(close, p.emaLength);
    // Pine's Supertrend uses -1 for bullish; expose the more intuitive +1 here.
    const direction = st.direction.map((d) => -d);
    const buy = new Array(bars.length).fill(0);
    const sell = new Array(bars.length).fill(0);
    const markers = [];
    for (let i = 1; i < bars.length; i++) {
      // The first ATR value initializes the trail; it is not a reversal signal.
      if (!Number.isFinite(direction[i - 1]) || !Number.isFinite(direction[i])) continue;
      const allowBuy = p.trendFilter === 'Off' || close[i] > trend[i];
      const allowSell = p.trendFilter === 'Off' || close[i] < trend[i];
      buy[i] = direction[i] === 1 && direction[i - 1] === -1 && allowBuy ? 1 : 0;
      sell[i] = direction[i] === -1 && direction[i - 1] === 1 && allowSell ? 1 : 0;
      if (buy[i] || sell[i]) markers.push({
        time: bars[i].time,
        position: buy[i] ? 'belowBar' : 'aboveBar',
        shape: buy[i] ? 'arrowUp' : 'arrowDown',
        color: buy[i] ? '#26a69a' : '#ef5350',
        text: buy[i] ? 'Buy' : 'Sell',
      });
    }
    // Per-point colors also override saved signal colors in legacy renderers. Without
    // this, a 0→1 histogram can paint a full-height column even with autoscale off.
    const colors = new Array(bars.length).fill('rgba(0,0,0,0)');
    return { bullish: st.up, bearish: st.down, trend, buy, sell, direction, markers, colors };
  },
};
