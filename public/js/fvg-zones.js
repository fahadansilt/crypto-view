import { fmtPrice } from './api.js';

// A price-chart primitive: it never creates an extra series or changes autoscaling.
export class FvgZones {
  constructor(pane, zones) {
    this.pane = pane;
    this.zones = zones;
    this.view = {
      zOrder: () => 'bottom',
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace((scope) => this.draw(scope)) }),
    };
  }
  attached({ series }) { this.series = series; }
  detached() { this.series = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }
  draw({ context: ctx, mediaSize: { width, height } }) {
    if (!this.series || !this.pane.shown.length) return;
    ctx.save();
    ctx.font = '10px sans-serif';
    const labels = [];
    for (const zone of this.zones) {
      const upper = this.series.priceToCoordinate(zone.upper);
      const lower = this.series.priceToCoordinate(zone.lower);
      if (!Number.isFinite(upper) || !Number.isFinite(lower)) continue;
      const top = Math.min(upper, lower), bottom = Math.max(upper, lower);
      if (bottom < 0 || top > height) continue;
      const i = this.pane.shown.findIndex((b) => b.time >= zone.created);
      if (i < 0) continue;
      const x = this.pane.chart.timeScale().logicalToCoordinate(i);
      if (!Number.isFinite(x) || x > width) continue;
      const left = Math.max(0, x);
      const bullish = zone.side === 'bullish';
      ctx.fillStyle = bullish ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';
      ctx.strokeStyle = bullish ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(left, top, width - left, bottom - top);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(left + 0.5, top + 0.5, width - left, Math.max(1, bottom - top));
      ctx.setLineDash([]);
      const text = `${bullish ? 'Bull' : 'Bear'} FVG ${fmtPrice(zone.lower)}–${fmtPrice(zone.upper)}${zone.touched ? ' · partial' : ''}`;
      const tw = ctx.measureText(text).width;
      let y = Math.max(12, Math.min(height - 4, top - 4));
      while (labels.some((other) => Math.abs(other - y) < 14) && y < height - 18) y += 14;
      labels.push(y);
      // Labels must fit even when a new zone begins at the chart's right edge.
      const tx = Math.max(4, width - tw - 8);
      ctx.fillStyle = 'rgba(18,22,32,0.85)';
      ctx.fillRect(tx - 3, y - 10, tw + 6, 13);
      ctx.fillStyle = bullish ? '#49c8b9' : '#ff8582';
      ctx.fillText(text, tx, y);
    }
    ctx.restore();
  }
}
