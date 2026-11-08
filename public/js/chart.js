// One chart: candles + volume + any number of indicators, drawings, compare symbols, replay and live data.
import { api, fmtPrice, fmtPct, esc, ticker, exchange } from "./api.js";
import { BY_ID, compute, periodKey } from "../lib/indicators.js";
import {
  parseTf,
  bucketStart,
  isIntraday,
  heikinAshi,
  renko,
  lineBreak,
  rangeBars,
  kagi,
  pointFigure,
} from "../lib/series.js";
import { DrawingLayer, TOOL_BY_ID } from "./drawings.js";
import { VolumeProfile, SessionVolumeProfile } from "./volume-profile.js";
import { FvgZones } from "./fvg-zones.js";

const LW = window.LightweightCharts;

function candleCloseTime(time, tf) {
  const { n, unit, seconds } = parseTf(tf);
  if (unit === "M") {
    const next = new Date(bucketStart(time, tf) * 1000);
    next.setUTCMonth(next.getUTCMonth() + n);
    return next.getTime() / 1000;
  }
  if (unit === "W") return bucketStart(time, tf) + seconds;
  return time + seconds;
}

function formatTimeLeft(seconds) {
  const pad = (value) => String(value).padStart(2, "0");
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  if (hours) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

export const CHART_TYPES = [
  ["candles", "Candles"],
  ["hollow", "Hollow candles"],
  ["bars", "Bars"],
  ["heikin", "Heikin Ashi"],
  ["line", "Line"],
  ["linemarkers", "Line with markers"],
  ["step", "Step line"],
  ["area", "Area"],
  ["baseline", "Baseline"],
  ["columns", "Columns"],
  ["renko", "Renko"],
  ["linebreak", "Line break"],
  ["range", "Range bars"],
  ["kagi", "Kagi"],
  ["pnf", "Point & figure"],
];
// Chart types built from price alone, with no meaningful volume per bar.
const PRICE_ONLY = ["renko", "linebreak", "kagi", "pnf"];
const BINANCE_WS_TF = {
  "1s": "1s",
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "8h",
  "12h": "12h",
  "1D": "1d",
  "3D": "3d",
  "1W": "1w",
  "1M": "1M",
};
const ICON = {
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let uidSeq = 0;
export const newUid = () =>
  `i${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

// A chart line can't skip a blank point: it joins the neighbours. A segment takes the colour of
// the point it starts from, so hiding a gap means making the point before it transparent and
// parking the gap's points (invisibly) at the next real value.
const CLEAR = "rgba(0,0,0,0)";
function lineData(vals, breaks, timeAt, n) {
  const out = [];
  const next = new Array(vals.length);
  let nv = NaN;
  for (let i = vals.length - 1; i >= 0; i--) { if (Number.isFinite(vals[i])) nv = vals[i]; next[i] = nv; }
  let started = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i], time = timeAt(i);
    if (!Number.isFinite(v)) {
      if (i >= n) continue;
      out.push(started && Number.isFinite(next[i]) ? { time, value: next[i], color: CLEAR } : { time });
      continue;
    }
    started = true;
    const gapAhead = i + 1 < vals.length && (!Number.isFinite(vals[i + 1]) || breaks?.[i + 1]);
    out.push(gapAhead ? { time, value: v, color: CLEAR } : { time, value: v });
  }
  return out;
}
function histData(vals, colors, timeAt, n) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (i >= n && !Number.isFinite(v)) continue;
    if (!Number.isFinite(v)) out.push({ time: timeAt(i) });
    else out.push(colors ? { time: timeAt(i), value: v, color: colors[i] } : { time: timeAt(i), value: v });
  }
  return out;
}

// Higher-timeframe values onto chart bars. A chart bar sees a higher-timeframe bar only once that
// bar has finished, except inside the newest one, where it shows the still-forming value (as
// TradingView does in real time).
function mapToChart(res, hb, htf, cb, ctf) {
  const hSec = parseTf(htf).seconds, cSec = parseTf(ctf).seconds;
  const end = (j) => (j + 1 < hb.length ? hb[j + 1].time : hb[j].time + hSec);
  const idx = new Array(cb.length).fill(-1);
  let j = -1;
  for (let i = 0; i < cb.length; i++) {
    const cEnd = cb[i].time + cSec;
    while (j + 1 < hb.length && end(j + 1) <= cEnd) j++;
    idx[i] = j + 1 === hb.length - 1 && cb[i].time >= hb[hb.length - 1].time ? hb.length - 1 : j;
  }
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    if (k === "markers") continue;
    out[k] = Array.isArray(v) && v.length >= hb.length ? idx.map((x) => (x >= 0 ? v[x] : NaN)) : v;
  }
  return out;
}

export class ChartPane {
  constructor(app, el, cfg) {
    this.app = app;
    this.el = el;
    this.cfg = {
      symbol: "BINANCE:BTCUSDT",
      tf: "1D",
      type: "candles",
      indicators: [],
      compare: [],
      log: false,
      ...cfg,
    };
    this.bars = [];
    this.shown = [];
    this.times = [];
    this.indSeries = new Map();
    this.indResults = {};
    this.compareSeries = new Map();
    this.extraMarkers = [];
    this.tradePriceLines = [];
    this.tradeOverlay = null;
    this.replay = null;
    this.wsWatchTimer = null;
    this.wsConnectTimer = null;
    this.wsPollTimer = null;
    this.forcePollingUntil = 0;
    el.innerHTML =
      '<div class="chart"></div><div class="price-countdown hidden"><span class="price"></span><span class="remaining"></span></div><div class="legend"></div><div class="pane-msg hidden"></div>';
    this.chartEl = el.querySelector(".chart");
    this.priceCountdownEl = el.querySelector(".price-countdown");
    this.legendEl = el.querySelector(".legend");
    this.msgEl = el.querySelector(".pane-msg");
    this.countdownTimer = setInterval(() => this.updateCountdown(), 1000);
    this.onVisibilityChange = () => {
      if (document.hidden) this.suspendedAt = Date.now();
      else this.refreshAfterResume();
    };
    this.onWindowBlur = () => {
      this.suspendedAt ||= Date.now();
    };
    this.onWindowFocus = () => this.refreshAfterResume();
    this.onPageShow = (event) => {
      if (event.persisted) this.suspendedAt ||= Date.now() - 5000;
      this.refreshAfterResume();
    };
    this.onPageHide = () => {
      this.suspendedAt ||= Date.now();
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("focus", this.onWindowFocus);
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("pagehide", this.onPageHide);
    this.createChart();
    el.addEventListener("mousedown", () => app.setActive(this), true);
  }

  refreshAfterResume() {
    if (document.hidden) return;
    const suspendedAt = this.suspendedAt;
    this.suspendedAt = 0;
    if (
      !suspendedAt ||
      Date.now() - suspendedAt < 2000 ||
      Date.now() - (this.lastResumeRefresh || 0) < 5000 ||
      this.replay ||
      !this.bars.length
    ) return;
    this.lastResumeRefresh = Date.now();
    this.load({ keepView: true });
  }

  // ---------- setup ----------
  themeOptions() {
    return {
      layout: {
        background: { type: "solid", color: css("--bg") },
        textColor: css("--text"),
        fontSize: 11,
        panes: {
          separatorColor: css("--border"),
          separatorHoverColor: css("--accent-soft"),
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: css("--grid") },
        horzLines: { color: css("--grid") },
      },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border") },
    };
  }

  createChart() {
    this.chart = LW.createChart(this.chartEl, {
      autoSize: true,
      ...this.themeOptions(),
      crosshair: { mode: LW.CrosshairMode.Normal },
      timeScale: {
        borderColor: css("--border"),
        rightOffset: 8,
        timeVisible: true,
        secondsVisible: false,
      },
      localization: { priceFormatter: (p) => fmtPrice(p) },
    });
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.chart.subscribeClick((p) => {
      if (this.justDragged || Date.now() - (this.lastDrawingActionTime || 0) < 600) return;
      if (this.app.tool === "cursor") this.onClick(p);
    });
    // Lightweight Charts drops a second click that lands within 500ms of the first (it waits for a
    // double-click), so drawing tools read native clicks instead.
    this.chartEl.addEventListener("click", (e) => {
      if (this.justDragged || Date.now() - (this.lastDrawingActionTime || 0) < 600) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (this.app.tool === "cursor") return;
      const r = this.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      const inPlot =
        x >= 0 &&
        x <= this.chart.timeScale().width() &&
        y >= 0 &&
        y <= this.chart.panes()[0].getHeight();
      this.onClick({
        point: inPlot ? { x, y } : undefined,
        logical: inPlot ? this.chart.timeScale().coordinateToLogical(x) : null,
        paneIndex: 0,
      });
    });
    this.drawings = new DrawingLayer(this);
    this.chartEl.addEventListener(
      "pointerdown",
      (e) => this.onChartPointerDown(e),
      { capture: true },
    );
    this.chartEl.addEventListener("pointermove", (e) => this.onChartHover(e));
    this.chartEl.addEventListener("pointerleave", () => {
      if (!this.dragState) {
        this.chartEl.classList.remove("cursor-grab", "cursor-crosshair");
      }
    });
    this.chartEl.addEventListener("dblclick", (e) => {
      if (this.app.tool !== "cursor") return;
      const r = this.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      const hit = this.drawings.hitTest(x, y);
      if (hit && hit.type === "text") {
        const newText = prompt("Edit note text:", hit.text || "");
        if (newText !== null && newText.trim() !== "") {
          hit.text = newText;
          this.drawings.update();
          this.app.saveDrawings(this.cfg.symbol, this.drawings.items);
        }
      }
    });
    this.makeMainSeries();
  }

  applyTheme() {
    this.chart.applyOptions(this.themeOptions());
    this.render(false);
  }

  makeMainSeries() {
    for (const vp of this.vpPrims || []) { try { this.main?.detachPrimitive(vp); } catch { /* gone */ } }
    this.vpPrims = [];
    if (this.main) {
      this.main.detachPrimitive(this.drawings);
      this.chart.removeSeries(this.main);
      this.tradePriceLines = [];
    }
    if (this.volume) {
      this.chart.removeSeries(this.volume);
      this.volume = null;
    }
    const up = css("--up"),
      down = css("--down"),
      accent = css("--accent");
    const t = this.cfg.type;
    const common = { priceLineVisible: true, lastValueVisible: true };
    if (t === "bars")
      this.main = this.chart.addSeries(LW.BarSeries, {
        ...common,
        upColor: up,
        downColor: down,
      });
    else if (["line", "linemarkers", "step", "kagi"].includes(t))
      this.main = this.chart.addSeries(LW.LineSeries, {
        ...common,
        color: accent,
        lineWidth: 2,
        lineType: t === "step" || t === "kagi" ? 1 : 0,
        pointMarkersVisible: t === "linemarkers",
      });
    else if (t === "area")
      this.main = this.chart.addSeries(LW.AreaSeries, {
        ...common,
        lineColor: accent,
        topColor: "rgba(41,98,255,0.35)",
        bottomColor: "rgba(41,98,255,0.02)",
        lineWidth: 2,
      });
    else if (t === "baseline")
      this.main = this.chart.addSeries(LW.BaselineSeries, {
        ...common,
        topLineColor: up,
        bottomLineColor: down,
        topFillColor1: "rgba(8,153,129,0.25)",
        topFillColor2: "rgba(8,153,129,0.02)",
        bottomFillColor1: "rgba(242,54,69,0.02)",
        bottomFillColor2: "rgba(242,54,69,0.25)",
      });
    else if (t === "columns")
      this.main = this.chart.addSeries(LW.HistogramSeries, { ...common });
    else if (t === "hollow")
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: "rgba(0,0,0,0)",
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: true,
      });
    else
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: up,
        downColor: down,
        borderVisible: false,
        wickUpColor: up,
        wickDownColor: down,
      });
    this.main.attachPrimitive(this.drawings);
    this.markers = LW.createSeriesMarkers(this.main, []);
    this.mainType = t;
    if (
      !PRICE_ONLY.includes(t) &&
      this.app.settings.volume !== false
    ) {
      this.volume = this.chart.addSeries(LW.HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      this.chart
        .priceScale("vol")
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
  }

  // ---------- time helpers (drawings, legend, markers all go through these) ----------
  get shift() {
    return isIntraday(this.cfg.tf) && !this.app.settings.utc
      ? -new Date().getTimezoneOffset() * 60
      : 0;
  }
  get step() {
    return this.times.length > 1
      ? this.times.at(-1) - this.times.at(-2)
      : parseTf(this.cfg.tf).seconds;
  }
  toChart(t) {
    return t + this.shift;
  }

  logicalOf(utc) {
    const T = this.times,
      t = utc + this.shift,
      n = T.length;
    if (!n) return null;
    if (t <= T[0]) return (t - T[0]) / this.step;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.step;
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }

  timeOfLogical(l) {
    const T = this.times,
      n = T.length;
    if (!n) return null;
    let t;
    if (l <= 0) t = T[0] + l * this.step;
    else if (l >= n - 1) t = T[n - 1] + (l - (n - 1)) * this.step;
    else {
      const i = Math.floor(l);
      t = T[i] + (l - i) * (T[i + 1] - T[i]);
    }
    return t - this.shift;
  }

  timeToX(utc) {
    const l = this.logicalOf(utc);
    return l == null ? null : this.chart.timeScale().logicalToCoordinate(l);
  }

  formatPrice(v) {
    return fmtPrice(v);
  }

  snapToBar(utcSec) {
    if (!utcSec) return null;
    const bars = this.shown?.length ? this.shown : this.bars;
    if (!bars || !bars.length) return utcSec;
    if (utcSec <= bars[0].time) return bars[0].time;
    if (utcSec >= bars[bars.length - 1].time) return bars[bars.length - 1].time;
    let lo = 0,
      hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const bTime = bars[mid].time;
      const nextTime = mid + 1 < bars.length ? bars[mid + 1].time : Infinity;
      if (utcSec >= bTime && utcSec < nextTime) {
        return bTime;
      }
      if (bTime < utcSec) lo = mid + 1;
      else hi = mid - 1;
    }
    const idx = Math.max(0, Math.min(bars.length - 1, lo));
    return bars[idx].time;
  }

  // ---------- data ----------
  async load({ keepView = false } = {}) {
    const token = (this.loadToken = {});
    const previousBars = this.bars;
    this.stopLive();
    this.showMsg(`Loading ${ticker(this.cfg.symbol)}…`);
    try {
      const limit = this.app.settings.bars || 3000;
      const r = await api.candles(this.cfg.symbol, this.cfg.tf, limit);
      if (token !== this.loadToken) return;
      this.cfg.symbol = r.symbol;
      this.provider = r.provider;
      this.notes = r.notes || [];
      this.bars = r.candles;
      this.mtf = {};
      this.replay = null;
      this.el.querySelector(".replay-bar")?.remove();
      this.drawings.setItems(this.app.getDrawings(r.symbol));
      this.showMsg(
        this.bars.length ? "" : "No data for this symbol and timeframe.",
      );
      await this.loadCompare();
      this.render(!keepView);
      this.startLive();
      this.app.onPaneLoaded(this);
    } catch (e) {
      if (token !== this.loadToken) return;
      if (previousBars.length) {
        this.bars = previousBars;
        this.render(false);
        this.showMsg("");
        this.startLive();
      } else {
        this.bars = [];
        this.render(true);
        this.showMsg(
          `Couldn't load ${esc(this.cfg.symbol)} on ${esc(this.cfg.tf)}.\n${esc(e.message)}`,
        );
      }
    }
  }

  async loadCompare() {
    this.compareData = {};
    await Promise.all(
      this.cfg.compare.map(async (sym) => {
        try {
          this.compareData[sym] = (
            await api.candles(sym, this.cfg.tf, this.app.settings.bars || 3000)
          ).candles;
        } catch {
          this.compareData[sym] = [];
        }
      }),
    );
  }

  showMsg(text) {
    this.msgEl.classList.toggle("hidden", !text);
    this.msgEl.innerHTML = esc(text).replace(/\n/g, "<br>");
  }

  visibleBars() {
    const raw = this.replay
      ? this.bars.slice(0, this.replay.index + 1)
      : this.bars;
    switch (this.cfg.type) {
      case "heikin":
        return heikinAshi(raw);
      case "renko":
        return renko(raw);
      case "linebreak":
        return lineBreak(raw);
      case "range":
        return rangeBars(raw);
      case "kagi":
        return kagi(raw);
      case "pnf":
        return pointFigure(raw);
      default:
        return raw;
    }
  }

  pointFor(b) {
    const time = this.toChart(b.time);
    switch (this.mainType) {
      case "line":
      case "linemarkers":
      case "step":
      case "area":
      case "baseline":
        return { time, value: b.close };
      case "kagi":
        return { time, value: b.close, color: b.color };
      case "columns":
        return {
          time,
          value: b.close,
          color: b.close >= b.open ? css("--up") : css("--down"),
        };
      default:
        return { time, open: b.open, high: b.high, low: b.low, close: b.close };
    }
  }

  volPoint(b) {
    return {
      time: this.toChart(b.time),
      value: b.volume || 0,
      color:
        b.close >= b.open ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)",
    };
  }

  render(resetView) {
    const prevRange = this.chart.timeScale().getVisibleLogicalRange();
    const atEnd =
      prevRange && this.shown.length && prevRange.to >= this.shown.length - 3;
    if (
      this.mainType !== this.cfg.type ||
      !!this.volume !==
        (!PRICE_ONLY.includes(this.cfg.type) &&
          this.app.settings.volume !== false)
    )
      this.makeMainSeries();
    this.shown = this.visibleBars();
    this.times = this.shown.map((b) => this.toChart(b.time));
    const last = this.shown.at(-1)?.close || 1;
    const precision = last >= 100 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 6 : 8;
    this.main.applyOptions({
      priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision },
    });
    if (this.cfg.type === "baseline" && this.shown.length)
      this.main.applyOptions({
        baseValue: {
          type: "price",
          price: this.shown[Math.max(0, this.shown.length - 150)].close,
        },
      });
    this.main.setData(this.shown.map((b) => this.pointFor(b)));
    this.volume?.setData(this.shown.map((b) => this.volPoint(b)));
    this.chart.applyOptions({
      timeScale: {
        timeVisible: isIntraday(this.cfg.tf),
        secondsVisible: parseTf(this.cfg.tf).seconds < 60,
      },
    });
    this.chart.priceScale("right").applyOptions({
      invertScale: !!this.cfg.invert,
      mode: this.cfg.compare.length || this.cfg.percent
        ? LW.PriceScaleMode.Percentage
        : this.cfg.log
          ? LW.PriceScaleMode.Logarithmic
          : LW.PriceScaleMode.Normal,
    });
    this.renderCompare();
    this.renderIndicators();
    this.drawings.update();
    if (this.tradeOverlay && !this.tradePriceLines.length) {
      this.applyTradeOverlay(this.tradeOverlay, { autoFrame: resetView });
    }
    if (resetView && this.shown.length && !this.tradeOverlay)
      this.chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, this.shown.length - 160),
        to: this.shown.length + 8,
      });
    if (!resetView && this.shown.length && (this.replay || atEnd)) {
      const w = prevRange ? Math.max(20, prevRange.to - prevRange.from) : 160;
      const n = this.shown.length;
      this.chart
        .timeScale()
        .setVisibleLogicalRange({ from: n - w + 8, to: n + 8 });
    }
    this.updateLegend();
  }

  renderCompare() {
    for (const s of this.compareSeries.values()) this.chart.removeSeries(s);
    this.compareSeries.clear();
    const palette = ["#ff9800", "#e91e63", "#00bcd4", "#8bc34a", "#9c27b0"];
    this.cfg.compare.forEach((sym, k) => {
      const data = (this.compareData?.[sym] || []).filter(
        (b) => !this.replay || b.time <= this.shown.at(-1)?.time,
      );
      const s = this.chart.addSeries(LW.LineSeries, {
        color: palette[k % palette.length],
        lineWidth: 2,
        priceLineVisible: false,
        title: ticker(sym),
      });
      s.setData(
        data.map((b) => ({ time: this.toChart(b.time), value: b.close })),
      );
      this.compareSeries.set(sym, s);
    });
  }

  // Indicator values for one instance: on the chart's bars, on another indicator's output
  // (source "ind:<uid>:<output>"), or on a higher timeframe mapped back without look-ahead.
  computeIndicator(ind, bars) {
    const src = String(ind.params?.source || "");
    if (ind.tf && ind.tf !== this.cfg.tf) {
      const h = this.mtf[ind.tf];
      if (!h) { this.loadMtf(ind.tf); return { pending: true }; }
      if (h.error) return { error: h.error };
      let hb = h.bars;
      if (this.replay && bars.length) {
        // replay: only higher-timeframe bars that had finished by the replayed bar
        const cEnd = bars.at(-1).time + parseTf(this.cfg.tf).seconds, hs = parseTf(ind.tf).seconds;
        hb = hb.filter((x, j) => (j + 1 < hb.length ? hb[j + 1].time : x.time + hs) <= cEnd);
      }
      if (!hb.length) return {};
      const res = compute(ind.id, hb, src.startsWith("ind:") ? { ...ind.params, source: "close" } : ind.params);
      return mapToChart(res, hb, ind.tf, bars, this.cfg.tf);
    }
    if (src.startsWith("ind:")) {
      const [, uid, key] = src.split(":");
      const vals = this.indResults[uid]?.[key];
      if (!Array.isArray(vals)) return { error: "Its source indicator is missing" };
      const synth = bars.map((x, i) => { const v = vals[i]; return { ...x, open: v, high: v, low: v, close: v }; });
      return compute(ind.id, synth, { ...ind.params, source: "close" });
    }
    return compute(ind.id, bars, ind.params);
  }

  async loadMtf(tf) {
    this.mtfLoading ||= {};
    if (this.mtfLoading[tf]) return;
    this.mtfLoading[tf] = true;
    try {
      if (parseTf(tf).seconds < parseTf(this.cfg.tf).seconds) throw new Error(`Pick a timeframe at or above the chart's (${this.cfg.tf})`);
      const r = await api.candles(this.cfg.symbol, tf, 2000);
      this.mtf[tf] = { bars: r.candles, at: Date.now() };
    } catch (e) {
      this.mtf[tf] = { error: e.message, at: Date.now() };
    }
    delete this.mtfLoading[tf];
    this.render(false);
  }

  renderIndicators() {
    for (const list of this.indSeries.values())
      for (const s of list) {
        try { this.chart.removeSeries(s); } catch { /* already gone */ }
      }
    this.indSeries.clear();
    for (const vp of this.vpPrims || []) { try { this.main.detachPrimitive(vp); } catch { /* gone with the series */ } }
    this.vpPrims = [];
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
    this.indResults = {};
    this.mtf ||= {};
    const bars = this.shown, n = bars.length;
    const timeAt = (i) => (i < n ? this.times[i] : this.times[n - 1] + (i - n + 1) * this.step);
    // indicators built on another indicator's output go after their source
    const byUid = new Map(this.cfg.indicators.map((x) => [x.uid, x]));
    const depth = (x, seen = new Set()) => {
      const src = String(x.params?.source || "");
      if (!src.startsWith("ind:") || seen.has(x.uid)) return 0;
      seen.add(x.uid);
      const parent = byUid.get(src.split(":")[1]);
      return parent ? 1 + depth(parent, seen) : 0;
    };
    const ordered = [...this.cfg.indicators].sort((x, y) => depth(x) - depth(y));
    let paneIdx = 0;
    const paneOf = {};
    const markers = [];
    for (const ind of ordered) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      let res;
      try { res = n ? this.computeIndicator(ind, bars) : {}; } catch (e) { res = { error: e.message }; }
      this.indResults[ind.uid] = res;
      if (ind.hidden || this.cfg.hideIndicators || !n) continue;
      if (res.markers && !ind.tf) markers.push(...res.markers);
      if (Array.isArray(res.fvgZones) && res.fvgZones.length) {
        const fvg = new FvgZones(this, res.fvgZones);
        this.main.attachPrimitive(fvg);
        this.vpPrims.push(fvg);
      }
      if (res.volumeProfile) {
        const vp = new VolumeProfile(this, res.volumeProfile);
        this.main.attachPrimitive(vp);
        this.vpPrims.push(vp);
      }
      if (res.sessionProfile) {
        const sp = new SessionVolumeProfile(this, res.sessionProfile);
        sp.keyOf = periodKey;
        sp.tfSeconds = parseTf(this.cfg.tf).seconds;
        this.main.attachPrimitive(sp);
        this.vpPrims.push(sp);
      }
      const outs = def.outputs.filter((o) => o.visible !== false && Array.isArray(res[o.key]));
      if (!outs.length) continue;
      const src = String(ind.params?.source || "");
      const parentPane = src.startsWith("ind:") ? paneOf[src.split(":")[1]] : undefined;
      const pane = parentPane !== undefined ? parentPane : def.overlay ? 0 : ++paneIdx;
      paneOf[ind.uid] = pane;
      const list = [];
      for (const out of outs) {
        const color = ind.colors?.[out.key] || out.color;
        const opts = {
          ...(def.noAutoscale ? { autoscaleInfoProvider: () => null } : {}),
          ...(def.volumeFormat ? { priceFormat: { type: "volume" } } : {}),
          color,
          priceLineVisible: false,
          lastValueVisible: pane > 0,
          crosshairMarkerVisible: false,
          title: "",
        };
        const s = out.kind === "histogram"
          ? this.chart.addSeries(LW.HistogramSeries, opts, pane)
          : this.chart.addSeries(LW.LineSeries, { ...opts, lineWidth: out.lineWidth || 1, ...(out.dots ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}) }, pane);
        const vals = res[out.key];
        s.setData(out.kind === "histogram" ? histData(vals, res.colors, timeAt, n) : lineData(vals, res.breaks, timeAt, n));
        list.push(s);
      }
      if (parentPane === undefined)
        for (const lv of def.levels || [])
          list[0].createPriceLine({ price: lv, color: css("--muted"), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
      this.indSeries.set(ind.uid, list);
    }
    this.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 1 : 0.28));
    const all = [...markers, ...this.extraMarkers]
      .map((m) => ({ ...m, time: this.toChart(m.time) }))
      .filter((m) => !this.replay || m.time <= this.times.at(-1));
    all.sort((x, y) => x.time - y.time);
    this.markers.setMarkers(all);
  }

  applyTradeOverlay(trade, { autoFrame = true } = {}) {
    if (!trade) return;
    this.clearTradeOverlay(false);
    this.tradeOverlay = trade;

    const isShort = trade.side === "short" || trade.side === "Short" || trade.is_short;
    const markers = [];

    // 1. Initial Entry marker
    const entryTime = this.snapToBar(trade.openTime || (trade.entries && trade.entries[0]?.time));
    const entryPrice = trade.entry != null ? trade.entry : (trade.entries && trade.entries[0]?.price);
    const initialStake = (trade.entries && trade.entries[0]?.stake != null)
      ? Number(trade.entries[0].stake)
      : (trade.entries && trade.entries[0]?.amount != null && entryPrice != null ? trade.entries[0].amount * entryPrice : null);
    const entryStakeStr = initialStake != null ? ` (+$${initialStake >= 10 ? Math.round(initialStake) : initialStake.toFixed(1)})` : "";
    if (entryTime && entryPrice != null) {
      markers.push({
        time: entryTime,
        position: isShort ? "aboveBar" : "belowBar",
        color: isShort ? "#f97316" : "#3b82f6",
        shape: isShort ? "arrowDown" : "arrowUp",
        text: `ENTRY @ ${this.formatPrice(entryPrice)}${entryStakeStr}`,
      });
    }

    // 2. Position Increases / DCA entries (skip index 0 if it's the initial entry)
    const entries = Array.isArray(trade.entries) ? trade.entries : [];
    const dcaEntries = entries.length > 1 ? entries.slice(1) : [];

    // Group DCA entries by snapped candle bar time to prevent visual congestion
    const dcaByBar = new Map();
    dcaEntries.forEach((e, idx) => {
      const t = this.snapToBar(e.time);
      if (t && e.price != null) {
        if (!dcaByBar.has(t)) dcaByBar.set(t, []);
        dcaByBar.get(t).push({
          ...e,
          dcaIndex: e.index != null ? e.index : idx + 2,
        });
      }
    });

    for (const [t, list] of dcaByBar.entries()) {
      if (list.length === 1) {
        const e = list[0];
        const stk = e.stake != null
          ? Number(e.stake)
          : (e.amount != null ? Number(e.amount) * Number(e.price) : null);
        const stkStr = stk != null ? ` (+$${stk >= 10 ? Math.round(stk) : stk.toFixed(1)})` : "";
        markers.push({
          time: t,
          position: isShort ? "aboveBar" : "belowBar",
          color: "#0ea5e9",
          shape: "square",
          text: `+DCA #${e.dcaIndex} @ ${this.formatPrice(e.price)}${stkStr}`,
        });
      } else {
        // Multiple DCAs on the same candle: merge into a single consolidated marker
        let totalAmt = 0;
        let totalCost = 0;
        let totalStk = 0;
        const indices = [];

        list.forEach((e) => {
          indices.push(e.dcaIndex);
          const amt = Number(e.amount) || 0;
          const pr = Number(e.price) || 0;
          if (amt > 0) {
            totalAmt += amt;
            totalCost += amt * pr;
          }
          if (e.stake != null) {
            totalStk += Number(e.stake);
          } else if (amt > 0 && pr > 0) {
            totalStk += amt * pr;
          }
        });

        const avgPrice = (totalAmt > 0 && totalCost > 0)
          ? totalCost / totalAmt
          : (list.reduce((sum, e) => sum + Number(e.price), 0) / list.length);

        const minIdx = Math.min(...indices);
        const maxIdx = Math.max(...indices);
        const rangeStr = minIdx === maxIdx ? `#${minIdx}` : `#${minIdx}–${maxIdx}`;
        const stkStr = totalStk > 0 ? ` (+$${totalStk >= 10 ? Math.round(totalStk) : totalStk.toFixed(1)})` : "";

        markers.push({
          time: t,
          position: isShort ? "aboveBar" : "belowBar",
          color: "#0ea5e9",
          shape: "square",
          text: `+${list.length}x DCA (${rangeStr}) @ ${this.formatPrice(avgPrice)}${stkStr}`,
        });
      }
    }

    // 3. Grinding & Partial Exits (include both trade.grindExits and non-final trade.exits)
    const rawGrinds = Array.isArray(trade.grindExits) ? trade.grindExits : [];
    const rawExits = Array.isArray(trade.exits) ? trade.exits : [];
    const partialExitsFromExits = trade.isOpen ? rawExits : (rawExits.length > 1 ? rawExits.slice(0, -1) : []);

    const seenExitKeys = new Set();
    const allGrindExits = [];
    [...rawGrinds, ...partialExitsFromExits].forEach((g, idx) => {
      const key = `${g.time}_${g.price}_${g.amount}`;
      if (!seenExitKeys.has(key)) {
        seenExitKeys.add(key);
        allGrindExits.push({ ...g, grindIndex: g.index != null ? g.index : idx + 1 });
      }
    });

    // Group grinding exits by snapped candle bar time
    const grindByBar = new Map();
    allGrindExits.forEach((g) => {
      const t = this.snapToBar(g.time);
      if (t && g.price != null) {
        if (!grindByBar.has(t)) grindByBar.set(t, []);
        grindByBar.get(t).push(g);
      }
    });

    for (const [t, list] of grindByBar.entries()) {
      if (list.length === 1) {
        const g = list[0];
        const stk = g.stake != null
          ? Math.abs(Number(g.stake))
          : ((g.price != null && g.amount != null) ? Number(g.price) * Math.abs(Number(g.amount)) : null);
        const stkStr = stk != null ? ` (-$${stk >= 10 ? Math.round(stk) : stk.toFixed(1)})` : "";
        markers.push({
          time: t,
          position: isShort ? "belowBar" : "aboveBar",
          color: "#f59e0b",
          shape: "circle",
          text: `GRIND #${g.grindIndex} @ ${this.formatPrice(g.price)}${stkStr}`,
        });
      } else {
        // Multiple Grinds on the same candle: merge into a single consolidated marker
        let totalAmt = 0;
        let totalCost = 0;
        let totalStk = 0;
        const indices = [];

        list.forEach((g) => {
          indices.push(g.grindIndex);
          const amt = Math.abs(Number(g.amount) || 0);
          const pr = Number(g.price) || 0;
          if (amt > 0) {
            totalAmt += amt;
            totalCost += amt * pr;
          }
          if (g.stake != null) {
            totalStk += Math.abs(Number(g.stake));
          } else if (amt > 0 && pr > 0) {
            totalStk += amt * pr;
          }
        });

        const avgPrice = (totalAmt > 0 && totalCost > 0)
          ? totalCost / totalAmt
          : (list.reduce((sum, g) => sum + Number(g.price), 0) / list.length);

        const minIdx = Math.min(...indices);
        const maxIdx = Math.max(...indices);
        const rangeStr = minIdx === maxIdx ? `#${minIdx}` : `#${minIdx}–${maxIdx}`;
        const stkStr = totalStk > 0 ? ` (-$${totalStk >= 10 ? Math.round(totalStk) : totalStk.toFixed(1)})` : "";

        markers.push({
          time: t,
          position: isShort ? "belowBar" : "aboveBar",
          color: "#f59e0b",
          shape: "circle",
          text: `−${list.length}x GRIND (${rangeStr}) @ ${this.formatPrice(avgPrice)}${stkStr}`,
        });
      }
    }

    // 4. Final Exit (if closed)
    const exitTime = this.snapToBar(trade.closeTime);
    const exitPrice = trade.exit != null ? trade.exit : (trade.exits && trade.exits[trade.exits.length - 1]?.price);
    if (!trade.isOpen && exitTime && exitPrice != null) {
      const pnlPct = trade.profitRatio != null
        ? `${trade.profitRatio >= 0 ? "+" : ""}${(trade.profitRatio * 100).toFixed(2)}%`
        : trade.profit != null
          ? `${trade.profit >= 0 ? "+" : ""}${trade.profit.toFixed(2)}`
          : "";
      const isWin = (trade.profitRatio != null ? trade.profitRatio >= 0 : (trade.profit != null ? trade.profit >= 0 : true));
      markers.push({
        time: exitTime,
        position: isShort ? "belowBar" : "aboveBar",
        color: isWin ? "#10b981" : "#ef4444",
        shape: "circle",
        text: `EXIT @ ${this.formatPrice(exitPrice)}${pnlPct ? ` (${pnlPct})` : ""}`,
      });
    }

    this.extraMarkers = markers;
    this.renderIndicators();

    // 5. Price lines on this.main
    if (this.main) {
      if (entryPrice != null) {
        this.tradePriceLines.push(
          this.main.createPriceLine({
            price: entryPrice,
            color: "#3b82f6",
            lineWidth: 2,
            lineStyle: LW?.LineStyle?.Dashed ?? 2,
            axisLabelVisible: true,
            title: `ENTRY (${this.formatPrice(entryPrice)})`,
          })
        );
      }
      if (trade.stopLoss != null && trade.stopLoss > 0) {
        this.tradePriceLines.push(
          this.main.createPriceLine({
            price: trade.stopLoss,
            color: "#ef4444",
            lineWidth: 1,
            lineStyle: LW?.LineStyle?.Dashed ?? 2,
            axisLabelVisible: true,
            title: `SL (${this.formatPrice(trade.stopLoss)})`,
          })
        );
      }
      if (trade.liquidation != null && trade.liquidation > 0) {
        this.tradePriceLines.push(
          this.main.createPriceLine({
            price: trade.liquidation,
            color: "#f59e0b",
            lineWidth: 1,
            lineStyle: LW?.LineStyle?.LargeDashed ?? 3,
            axisLabelVisible: true,
            title: `LIQ (${this.formatPrice(trade.liquidation)})`,
          })
        );
      }
      if (!trade.isOpen && exitPrice != null) {
        const isWin = (trade.profitRatio != null ? trade.profitRatio >= 0 : (trade.profit != null ? trade.profit >= 0 : true));
        this.tradePriceLines.push(
          this.main.createPriceLine({
            price: exitPrice,
            color: isWin ? "#10b981" : "#ef4444",
            lineWidth: 2,
            lineStyle: LW?.LineStyle?.Dashed ?? 2,
            axisLabelVisible: true,
            title: `EXIT (${this.formatPrice(exitPrice)})`,
          })
        );
      }
    }

    // 6. Auto-frame trade window if autoFrame is true
    if (autoFrame && this.shown?.length) {
      const tStart = trade.openTime || (trade.entries && trade.entries[0]?.time);
      const tEnd = (!trade.isOpen && trade.closeTime) ? trade.closeTime : (this.shown.at(-1)?.time);
      if (tStart) {
        const lStart = this.logicalOf(tStart);
        const lEnd = tEnd ? this.logicalOf(tEnd) : this.shown.length - 1;
        if (lStart != null && lEnd != null) {
          const lo = Math.min(lStart, lEnd);
          const hi = Math.max(lStart, lEnd);
          const span = Math.max(8, hi - lo);
          const pad = Math.max(10, Math.round(span * 0.25));
          const from = Math.max(0, Math.floor(lo - pad));
          const to = Math.min(this.shown.length + 15, Math.ceil(hi + pad));
          if (to > from) {
            this.chart.timeScale().setVisibleLogicalRange({ from, to });
          }
        }
      }
    }

    // 7. Render Floating Trade HUD
    this.renderTradeOverlayHud();
  }

  clearTradeOverlay(render = true) {
    if (this.main && this.tradePriceLines?.length) {
      for (const line of this.tradePriceLines) {
        try {
          this.main.removePriceLine(line);
        } catch (_) {}
      }
    }
    this.tradePriceLines = [];
    this.extraMarkers = [];
    this.tradeOverlay = null;
    this.el.querySelector(".trade-overlay-hud")?.remove();
    this.el.querySelector(".trade-hud-breakdown-popover")?.remove();
    if (render) {
      this.renderIndicators();
    }
  }

  renderTradeOverlayHud() {
    this.el.querySelector(".trade-overlay-hud")?.remove();
    if (!this.tradeOverlay) return;
    const trade = this.tradeOverlay;
    const isShort = trade.side === "short" || trade.side === "Short" || trade.is_short;
    const hud = document.createElement("div");
    hud.className = "trade-overlay-hud";

    const sideBadge = `<span class="trade-hud-badge ${isShort ? "short" : "long"}">${isShort ? "SHORT" : "LONG"}${trade.leverage && trade.leverage > 1 ? ` ${trade.leverage}x` : ""}</span>`;
    const pairBadge = trade.pair ? `<span class="trade-hud-pair">${esc(trade.pair)}</span>` : "";
    const idBadge = trade.id != null ? `<span class="trade-hud-id">#${esc(String(trade.id))}</span>` : "";
    const entryStat = trade.entry != null ? `<span class="trade-hud-stat">Entry: <b>${this.formatPrice(trade.entry)}</b></span>` : "";
    
    const dcaCount = (trade.entries?.length || 0) > 1 ? trade.entries.length - 1 : 0;
    const dcaStat = dcaCount > 0
      ? `<button class="trade-hud-stat dca interactive" data-act="breakdown" title="Click to view DCA & Stake Ledger">${dcaCount} DCA${dcaCount > 1 ? "s" : ""} ▾</button>`
      : "";

    const grindCount = trade.grindExits?.length || 0;
    const grindStat = grindCount > 0
      ? `<button class="trade-hud-stat grind interactive" data-act="breakdown" title="Click to view Grind Exits & Stake Ledger">${grindCount} Grind${grindCount > 1 ? "s" : ""} ▾</button>`
      : "";

    const ledgerBtn = (dcaCount === 0 && grindCount === 0 && (trade.entries?.length || trade.entry != null))
      ? `<button class="trade-hud-stat interactive" data-act="breakdown" title="Click to view execution fills">Ledger ▾</button>`
      : "";

    let pnlStat = "";
    if (!trade.isOpen) {
      const isWin = (trade.profitRatio != null ? trade.profitRatio >= 0 : (trade.profit != null ? trade.profit >= 0 : true));
      const pnlPct = trade.profitRatio != null ? `${trade.profitRatio >= 0 ? "+" : ""}${(trade.profitRatio * 100).toFixed(2)}%` : "";
      const pnlAbs = trade.profit != null ? ` (${trade.profit >= 0 ? "+" : ""}$${trade.profit.toFixed(2)})` : "";
      const reason = trade.exitReason ? ` [${esc(trade.exitReason)}]` : "";
      pnlStat = `<span class="trade-hud-pnl ${isWin ? "win" : "loss"}">${pnlPct}${pnlAbs}${reason}</span>`;
    } else {
      pnlStat = `<span class="trade-hud-pnl active"><span class="trade-hud-pulse"></span>ACTIVE</span>`;
    }

    hud.innerHTML = `
      <div class="trade-hud-left">
        ${sideBadge}
        ${pairBadge}
        ${idBadge}
      </div>
      <div class="trade-hud-mid">
        ${entryStat}
        ${dcaStat}
        ${grindStat}
        ${ledgerBtn}
        ${pnlStat}
      </div>
      <div class="trade-hud-right">
        <button class="trade-hud-fit-btn" title="Fit chart view to trade">Fit</button>
        <button class="trade-hud-close-btn" title="Clear trade overlay">✕ Clear</button>
      </div>
    `;

    hud.querySelectorAll("[data-act='breakdown']").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this.toggleTradeOrderBreakdown();
      };
    });

    hud.querySelector(".trade-hud-fit-btn").onclick = (e) => {
      e.stopPropagation();
      this.applyTradeOverlay(this.tradeOverlay, { autoFrame: true });
    };

    hud.querySelector(".trade-hud-close-btn").onclick = (e) => {
      e.stopPropagation();
      this.clearTradeOverlay(true);
      if (this.app) {
        this.app.tradeOverlay = null;
        try {
          const u = new URL(window.location.href);
          u.searchParams.delete("trade");
          window.history.replaceState(null, "", u.toString());
        } catch (_) {}
      }
    };

    this.el.appendChild(hud);
  }

  buildOrderLedger(trade) {
    const list = [];
    const entries = Array.isArray(trade.entries) ? trade.entries : [];
    const rawGrinds = Array.isArray(trade.grindExits) ? trade.grindExits : [];
    const exits = Array.isArray(trade.exits) ? trade.exits : [];
    const partialExitsFromExits = trade.isOpen ? exits : (exits.length > 1 ? exits.slice(0, -1) : []);

    const seenExitKeys = new Set();
    const grindExits = [];
    [...rawGrinds, ...partialExitsFromExits].forEach((g, idx) => {
      const key = `${g.time}_${g.price}_${g.amount}`;
      if (!seenExitKeys.has(key)) {
        seenExitKeys.add(key);
        grindExits.push({ ...g, index: g.index != null ? g.index : idx + 1 });
      }
    });

    // 1. Initial Entry & DCA position increases
    if (entries.length > 0) {
      entries.forEach((e, idx) => {
        const p = e.price != null ? Number(e.price) : trade.entry;
        const stake = e.stake != null
          ? Number(e.stake)
          : (e.amount != null && p != null ? Number(e.amount) * Number(p) : null);
        list.push({
          time: e.time || trade.openTime,
          type: idx === 0 ? "entry" : "dca",
          label: idx === 0 ? "Initial Entry" : `DCA #${e.index || idx + 1}`,
          price: p,
          amount: e.amount != null ? Number(e.amount) : null,
          stake: stake,
        });
      });
    } else if (trade.entry != null) {
      list.push({
        time: trade.openTime,
        type: "entry",
        label: "Initial Entry",
        price: Number(trade.entry),
        amount: null,
        stake: null,
      });
    }

    // 2. Grinding exits
    grindExits.forEach((g, idx) => {
      const p = g.price != null ? Number(g.price) : null;
      const stake = (p != null && g.amount != null) ? Number(p) * Number(g.amount) : null;
      list.push({
        time: g.time,
        type: "grind",
        label: `Grind Exit #${g.index || idx + 1}`,
        price: p,
        amount: g.amount != null ? -Math.abs(Number(g.amount)) : null,
        stake: stake != null ? -Math.abs(stake) : null,
      });
    });

    // 3. Final Exit if closed
    if (!trade.isOpen) {
      const closePrice = trade.exit != null
        ? Number(trade.exit)
        : (exits.length && exits[exits.length - 1]?.price != null ? Number(exits[exits.length - 1].price) : null);
      if (closePrice != null) {
        list.push({
          time: trade.closeTime || (exits.length ? exits[exits.length - 1]?.time : null),
          type: "close",
          label: `Final Close${trade.exitReason ? ` [${trade.exitReason}]` : ""}`,
          price: closePrice,
          amount: null,
          stake: null,
        });
      }
    }

    // Sort chronologically
    list.sort((a, b) => (a.time || 0) - (b.time || 0));

    // Calculate running cumulative stake
    let runningStake = 0;
    let maxStake = 0;
    for (const item of list) {
      if (item.stake != null) {
        runningStake += item.stake;
        if (runningStake > maxStake) maxStake = runningStake;
        item.cumStake = Math.max(0, runningStake);
      } else {
        item.cumStake = runningStake > 0 ? runningStake : null;
      }
    }

    return { orders: list, maxStake, currentStake: Math.max(0, runningStake) };
  }

  toggleTradeOrderBreakdown() {
    const existing = this.el.querySelector(".trade-hud-breakdown-popover");
    if (existing) {
      existing.remove();
      return;
    }
    if (!this.tradeOverlay) return;
    const trade = this.tradeOverlay;
    const { orders, maxStake, currentStake } = this.buildOrderLedger(trade);

    const popover = document.createElement("div");
    popover.className = "trade-hud-breakdown-popover";

    const rowsHtml = orders.map((o) => {
      const typeClass = o.type === "entry"
        ? "entry"
        : o.type === "dca"
          ? "dca"
          : o.type === "grind"
            ? "grind"
            : (trade.profitRatio != null && trade.profitRatio < 0 ? "close-loss" : "close");
      
      const priceStr = o.price != null ? `$${this.formatPrice(o.price)}` : "-";
      const amtStr = o.amount != null
        ? `${o.amount > 0 ? "+" : ""}${Math.abs(o.amount) >= 1000 ? Math.abs(o.amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.abs(o.amount).toFixed(4)}`
        : "-";
      const stkStr = o.stake != null
        ? `${o.stake >= 0 ? "+" : "-"}$${Math.abs(o.stake).toFixed(2)}`
        : "-";
      const cumStr = o.cumStake != null
        ? `$${o.cumStake.toFixed(2)}`
        : "-";

      const timeStr = o.time
        ? new Date(o.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
          " <span class='muted'>" +
          new Date(o.time * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) +
          "</span>"
        : "-";

      return `<tr>
        <td><span class="hud-order-tag ${typeClass}">${esc(o.label)}</span></td>
        <td style="color:var(--muted)">${timeStr}</td>
        <td style="text-align:right">${priceStr}</td>
        <td style="text-align:right">${amtStr}</td>
        <td style="text-align:right; font-weight:600; color:${o.stake != null ? (o.stake >= 0 ? '#38bdf8' : '#fbbf24') : 'inherit'}">${stkStr}</td>
        <td style="text-align:right; font-weight:700; color:#e2e8f0">${cumStr}</td>
      </tr>`;
    }).join("");

    popover.innerHTML = `
      <div class="hud-popover-header">
        <div class="hud-popover-title">
          <span class="hud-popover-pair">${esc(trade.pair || "")}</span>
          ${trade.id != null ? `<span class="hud-popover-id">#${esc(String(trade.id))}</span>` : ""}
          <span class="hud-popover-subtitle">Order & Stake Ledger</span>
        </div>
        <button class="hud-popover-close" title="Close breakdown">✕</button>
      </div>
      <div class="hud-popover-table-wrap">
        <table class="hud-popover-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Time</th>
              <th style="text-align:right">Price</th>
              <th style="text-align:right">Quantity</th>
              <th style="text-align:right">Stake</th>
              <th style="text-align:right">Net Stake</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="6" style="text-align:center; padding:16px; color:var(--muted)">No execution fills recorded</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="hud-popover-footer">
        <span>Active Exposure: <b>$${currentStake.toFixed(2)}</b></span>
        <span>Peak Position Stake: <b>$${maxStake.toFixed(2)}</b></span>
      </div>
    `;

    popover.querySelector(".hud-popover-close").onclick = (e) => {
      e.stopPropagation();
      popover.remove();
    };

    const onDocClick = (e) => {
      if (!popover.contains(e.target) && !e.target.closest("[data-act='breakdown']")) {
        popover.remove();
        document.removeEventListener("mousedown", onDocClick);
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
    }, 0);

    this.el.appendChild(popover);
  }

  // "14 on RSI 14 (1D)": the numeric inputs, what it's built on, and its timeframe.
  indicatorParamsLabel(ind) {
    const def = BY_ID[ind.id];
    if (!def) return "";
    const nums = (def.inputs || [])
      .filter((x) => x.type !== "source")
      .map((x) => {
        const v = ind.params?.[x.key] ?? x.default;
        if (x.type !== "time") return v;
        return v ? new Date(v * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "pick a bar";
      })
      .join(" ");
    const src = String(ind.params?.source || "");
    let on = "";
    if (src.startsWith("ind:")) {
      const parent = this.cfg.indicators.find((x) => x.uid === src.split(":")[1]);
      const pd = parent && BY_ID[parent.id];
      on = pd ? ` on ${(/\(([^)]+)\)$/.exec(pd.name)?.[1].split(" / ")[0] || pd.name)} ${this.indicatorParamsLabel(parent)}` : " on (missing)";
    }
    return `${nums}${on}${ind.tf && ind.tf !== this.cfg.tf ? ` (${ind.tf})` : ""}`;
  }

  // ---------- legend ----------
  onCrosshair(p) {
    if (this.app.tool !== "cursor" && this.drawings.temp && p.point) {
      const pt = this.pointAt(p);
      if (pt) {
        this.drawings.temp.points[this.drawings.temp.points.length - 1] = pt;
        this.drawings.update();
      }
    }
    const i =
      p.logical != null && p.point
        ? Math.max(0, Math.min(this.shown.length - 1, Math.round(p.logical)))
        : null;
    this.updateLegend(i);
    if (this.app.settings.syncCrosshair && p.time && p.point)
      this.app.syncCrosshair(this, p);
  }

  updateLegend(index = null) {
    const n = this.shown.length;
    const i = index ?? n - 1;
    const b = this.shown[i],
      prev = this.shown[i - 1];
    const chg = b && prev ? ((b.close - prev.close) / prev.close) * 100 : null;
    const cls = chg == null ? "" : chg >= 0 ? "up" : "down";
    const name = `${ticker(this.cfg.symbol)} · ${this.cfg.tf} · ${this.provider || exchange(this.cfg.symbol)}`;
    let html = `<div class="row"><span class="title" data-act="symbol">${esc(name)}</span>`;
    if (b)
      html += `<span class="ohlc ${cls}"><span><b>O</b>${fmtPrice(b.open)}</span><span><b>H</b>${fmtPrice(b.high)}</span><span><b>L</b>${fmtPrice(b.low)}</span><span><b>C</b>${fmtPrice(b.close)}</span><span>${fmtPct(chg)}</span></span>`;
    html += "</div>";
    for (const sym of this.cfg.compare) {
      html += `<div class="row ind" data-compare="${esc(sym)}"><span class="name">${esc(ticker(sym))} (compare)</span><span class="acts"><button data-act="rmcompare" title="Remove">${ICON.x}</button></span></div>`;
    }
    for (const ind of this.cfg.indicators) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      const res = this.indResults[ind.uid] || {};
      const params = this.indicatorParamsLabel(ind);
      const vals = res.error
        ? `<span class="down">${esc(res.error)}</span>`
        : res.pending
          ? '<span class="muted">loading…</span>'
          : def.outputs
            .filter((o) => o.visible !== false)
            .map((o) => {
              const v = res[o.key]?.[i];
              return Number.isFinite(v)
                ? `<span style="color:${ind.colors?.[o.key] || o.color}">${fmtPrice(v)}</span>`
                : "";
            })
            .join(" ");
      const short =
        /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
      html += `<div class="row ind" data-uid="${ind.uid}" style="${ind.hidden ? "opacity:.45" : ""}"><span class="name">${esc(short)} ${esc(params)}</span><span class="vals">${vals}</span><span class="acts"><button data-act="settings" title="Settings">${ICON.gear}</button><button data-act="hide" title="Show/hide">${ICON.eye}</button><button data-act="remove" title="Remove">${ICON.x}</button></span></div>`;
    }
    for (const note of this.notes || [])
      html += `<div class="row note">${esc(note)}</div>`;
    this.legendEl.innerHTML = html;
    this.legendEl.onclick = (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "symbol") return this.app.openSymbolSearch();
      if (act === "rmcompare") {
        this.cfg.compare = this.cfg.compare.filter(
          (s) => s !== btn.closest("[data-compare]").dataset.compare,
        );
        this.app.persist();
        return this.load({ keepView: true });
      }
      const uid = btn.closest("[data-uid]")?.dataset.uid;
      const ind = this.cfg.indicators.find((x) => x.uid === uid);
      if (!ind) return;
      if (act === "remove") this.removeIndicator(uid);
      if (act === "hide") {
        ind.hidden = !ind.hidden;
        this.render(false);
        this.app.persist();
      }
      if (act === "settings") this.app.openIndicatorSettings(this, ind);
    };
    this.updateCountdown();
  }

  updateCountdown() {
    const label = this.priceCountdownEl;
    if (!label) return;
    if (this.replay) {
      label.classList.add("hidden");
      return;
    }
    const last = this.shown.at(-1) || this.bars.at(-1);
    const y = last && this.main?.priceToCoordinate(last.close);
    const chartHeight = this.chartEl.clientHeight;
    const axisWidth = this.main?.priceScale().width() || 0;
    if (
      !last ||
      y == null ||
      !Number.isFinite(y) ||
      y < 0 ||
      y > chartHeight ||
      axisWidth <= 0
    ) {
      label.classList.add("hidden");
      return;
    }
    label.classList.remove("hidden");
    label.style.width = `${axisWidth}px`;
    label.style.top = `${Math.max(0, Math.min(chartHeight - label.offsetHeight, y - label.offsetHeight / 2))}px`;
    label.style.backgroundColor = css(last.close >= last.open ? "--up" : "--down");
    label.querySelector(".price").textContent = fmtPrice(last.close);
    const remaining = Math.max(
      0,
      Math.ceil(candleCloseTime(last.time, this.cfg.tf) - Date.now() / 1000),
    );
    label.querySelector(".remaining").textContent = formatTimeLeft(remaining);
  }

  updateLivePrice(last) {
    const row = this.legendEl.querySelector(".row:first-child");
    if (row) {
      const prev = this.shown.at(-2);
      const chg = prev
        ? ((last.close - prev.close) / prev.close) * 100
        : null;
      const cls = chg == null ? "" : chg >= 0 ? "up" : "down";
      let ohlc = row.querySelector(".ohlc");
      if (!ohlc) {
        ohlc = document.createElement("span");
        row.append(ohlc);
      }
      ohlc.className = `ohlc ${cls}`;
      ohlc.innerHTML = `<span><b>O</b>${fmtPrice(last.open)}</span><span><b>H</b>${fmtPrice(last.high)}</span><span><b>L</b>${fmtPrice(last.low)}</span><span><b>C</b>${fmtPrice(last.close)}</span><span>${fmtPct(chg)}</span>`;
    }
    this.updateCountdown();
  }

  // ---------- indicators ----------
  addIndicator(id, params = {}) {
    const uid = newUid();
    this.cfg.indicators.push({ uid, id, params });
    this.render(false);
    this.app.persist();
    return uid;
  }
  removeIndicator(uid) {
    this.cfg.indicators = this.cfg.indicators.filter((x) => x.uid !== uid);
    this.render(false);
    this.app.persist();
  }

  // ---------- drawing tools ----------
  pointAt(p) {
    if (p.paneIndex) return null; // drawings live on the price pane only
    if (!p.point || p.logical == null) return null;
    const logical =
      this.chart.timeScale().coordinateToLogical(p.point.x) ?? p.logical;
    const price = this.main.coordinateToPrice(p.point.y);
    const time = this.timeOfLogical(logical);
    return price == null || time == null ? null : { time, price };
  }

  onClick(p) {
    const tool = this.app.tool;
    if (tool === "anchor-pick") {
      const pick = this.app.pendingAnchor;
      const ind = pick?.pane === this && this.cfg.indicators.find((x) => x.uid === pick.uid);
      const pt = this.pointAt(p);
      if (!ind || !pt) return;
      // Snap to the raw bar under the click (works on Renko/Heikin Ashi too).
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      ind.params = { ...ind.params, [pick.key]: this.bars[i].time };
      this.app.pendingAnchor = null;
      this.app.setTool("cursor");
      this.render(false);
      this.app.persist();
      this.app.toast("Anchored.");
      return;
    }
    if (tool === "replay-pick") {
      const pt = this.pointAt(p);
      if (!pt) return;
      // map the clicked time back to the raw bars (works for Renko/Heikin Ashi too)
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      this.app.setTool("cursor");
      this.startReplay(Math.max(1, i));
      return;
    }
    if (tool === "cursor") {
      if (!p.point) return;
      if (this.justDragged || Date.now() - (this.lastDrawingActionTime || 0) < 600) return;
      this.drawings.selected = this.drawings.hitTest(p.point.x, p.point.y);
      this.drawings.update();
      return;
    }
    const def = TOOL_BY_ID[tool];
    const pt = this.pointAt(p);
    if (!def || !pt) return;
    const d = this.drawings;
    if (!d.temp) {
      d.temp = { id: newUid(), type: tool, points: [pt] };
      if (def.points > 1) d.temp.points.push({ ...pt });
    } else {
      d.temp.points[d.temp.points.length - 1] = pt;
      if (d.temp.points.length < def.points) d.temp.points.push({ ...pt });
      else d.temp.done = true;
    }
    if (def.points === 1) d.temp.done = true;
    if (d.temp.done) {
      const item = d.temp;
      delete item.done;
      d.temp = null;
      if (item.type === "text") {
        const text = prompt("Note text:", "");
        if (!text) {
          d.update();
          this.app.setTool("cursor");
          return;
        }
        item.text = text;
      }
      d.items.push(item);
      d.selected = item;
      this.app.saveDrawings(this.cfg.symbol, d.items);
      if (!this.app.settings.stayInDrawMode) this.app.setTool("cursor");
    }
    d.update();
  }

  deleteSelectedDrawing() {
    const d = this.drawings;
    if (!d.selected) return false;
    d.items = d.items.filter((x) => x !== d.selected);
    d.selected = null;
    d.update();
    this.app.saveDrawings(this.cfg.symbol, d.items);
    return true;
  }

  clearDrawings() {
    this.drawings.items = [];
    this.drawings.selected = null;
    this.drawings.temp = null;
    this.drawings.update();
    this.app.saveDrawings(this.cfg.symbol, []);
  }

  setInteractive(on) {
    this.chart.applyOptions({ handleScroll: on, handleScale: on });
    if (on && this.drawings.temp) {
      this.drawings.temp = null;
      this.drawings.update();
    }
  }

  onChartHover(e) {
    if (this.dragState) return;
    const r = this.chartEl.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const inPlot =
      x >= 0 &&
      x <= this.chart.timeScale().width() &&
      y >= 0 &&
      y <= this.chart.panes()[0].getHeight();
    if (!inPlot) {
      this.chartEl.classList.remove("cursor-grab", "cursor-crosshair");
      return;
    }
    const handle = this.drawings.selected
      ? this.drawings.hitTestHandle(x, y, this.drawings.selected)
      : null;
    if (handle) {
      this.chartEl.classList.remove("cursor-grab");
      this.chartEl.classList.add("cursor-crosshair");
    } else {
      const hit = this.drawings.hitTest(x, y);
      if (hit) {
        this.chartEl.classList.remove("cursor-crosshair");
        this.chartEl.classList.add("cursor-grab");
      } else {
        this.chartEl.classList.remove("cursor-grab", "cursor-crosshair");
      }
    }
  }

  onChartPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest(".legend, .pane-msg, .price-countdown")) return;
    const r = this.chartEl.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const inPlot =
      x >= 0 &&
      x <= this.chart.timeScale().width() &&
      y >= 0 &&
      y <= this.chart.panes()[0].getHeight();
    if (!inPlot) return;

    if (this.dragCleanup) {
      try { this.dragCleanup(); } catch {}
    }

    if (this.drawings.temp) return;

    let handle = this.drawings.selected
      ? this.drawings.hitTestHandle(x, y, this.drawings.selected)
      : null;
    let hit = null;

    if (!handle) {
      hit = this.drawings.hitTest(x, y);
      if (hit) {
        if (hit !== this.drawings.selected) {
          this.drawings.selected = hit;
          this.drawings.update();
        }
        handle = this.drawings.hitTestHandle(x, y, hit);
      }
    }

    if (!handle && !hit) return;

    e.stopPropagation();
    e.preventDefault();
    if (this.app.tool !== "cursor") {
      this.app.setTool("cursor");
    }
    this.app.setActive(this);
    this.lastDrawingActionTime = Date.now();

    try {
      e.target.setPointerCapture?.(e.pointerId);
    } catch {}

    const startLogical = this.chart.timeScale().coordinateToLogical(x);
    const startPrice = this.main.coordinateToPrice(y);
    const targetDrawing = handle ? handle.drawing : hit;

    this.dragState = {
      type: handle ? "handle" : "body",
      drawing: targetDrawing,
      handleIndex: handle ? handle.index : null,
      handleRole: handle ? handle.role : null,
      pointerId: e.pointerId,
      targetEl: e.target,
      startX: x,
      startY: y,
      startLogical,
      startPrice,
      origPoints: targetDrawing.points.map((p) => ({
        ...p,
        logical: this.logicalOf(p.time),
      })),
      moved: false,
    };

    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    this.chartEl.classList.remove("cursor-grab", "cursor-crosshair");
    this.chartEl.classList.add(handle ? "cursor-crosshair" : "cursor-grabbing");
    document.body.classList.add(handle ? "cursor-crosshair" : "cursor-grabbing");

    const onMove = (moveEv) => {
      if (!this.dragState) return;
      const rect = this.chartEl.getBoundingClientRect();
      const currX = moveEv.clientX - rect.left;
      const currY = moveEv.clientY - rect.top;
      const dx = currX - this.dragState.startX;
      const dy = currY - this.dragState.startY;
      if (!this.dragState.moved && Math.hypot(dx, dy) >= 3) {
        this.dragState.moved = true;
      }
      if (this.dragState.moved) {
        this.onDragMove(currX, currY);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("pointercancel", onUp, { capture: true });
      window.removeEventListener("mousemove", onMove, { capture: true });
      window.removeEventListener("mouseup", onUp, { capture: true });
      if (this.dragState?.targetEl && this.dragState?.pointerId != null) {
        try {
          this.dragState.targetEl.releasePointerCapture?.(this.dragState.pointerId);
        } catch {}
      }
      this.dragCleanup = null;
      this.chartEl.classList.remove("cursor-grab", "cursor-grabbing", "cursor-crosshair");
      document.body.classList.remove("cursor-grab", "cursor-grabbing", "cursor-crosshair");
      this.chart.applyOptions({ handleScroll: true, handleScale: true });

      if (this.dragState) {
        if (this.dragState.moved) {
          this.justDragged = true;
          setTimeout(() => { this.justDragged = false; }, 600);
          this.app.saveDrawings(this.cfg.symbol, this.drawings.items);
        }
        this.lastDrawingActionTime = Date.now();
        this.dragState = null;
      }
    };

    this.dragCleanup = onUp;
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onUp, { capture: true });
    window.addEventListener("mousemove", onMove, { capture: true });
    window.addEventListener("mouseup", onUp, { capture: true });
  }

  onDragMove(x, y) {
    if (!this.dragState) return;
    const {
      type,
      drawing,
      handleIndex,
      handleRole,
      origPoints,
      startLogical,
      startPrice,
    } = this.dragState;

    const timeScale = this.chart.timeScale();
    const pane0 = this.chart.panes()[0];
    const paneH = pane0 ? pane0.getHeight() : 400;
    const clampedY = Math.max(0, Math.min(paneH - 1, y));
    const logical = timeScale.coordinateToLogical(x);
    const price = this.main.coordinateToPrice(clampedY);
    if (logical == null || price == null) return;
    const time = this.timeOfLogical(logical);
    if (time == null) return;

    if (type === "handle") {
      if (drawing.type === "hline") {
        drawing.points[0].price = price;
        drawing.points[0].time = time;
      } else if (drawing.type === "vline") {
        drawing.points[0].time = time;
        drawing.points[0].price = price;
      } else if ((drawing.type === "rect" || drawing.type === "poc") && handleRole) {
        if (handleRole === "corner-a") {
          drawing.points[0] = { time, price };
        } else if (handleRole === "corner-b") {
          drawing.points[1] = { time, price };
        } else if (handleRole === "corner-b-x-a-y") {
          drawing.points[1].time = time;
          drawing.points[0].price = price;
        } else if (handleRole === "corner-a-x-b-y") {
          drawing.points[0].time = time;
          drawing.points[1].price = price;
        }
      } else {
        if (handleIndex != null && drawing.points[handleIndex]) {
          drawing.points[handleIndex] = { time, price };
        }
      }
      this.drawings.update();
    } else if (type === "body") {
      if (startLogical == null || startPrice == null) return;
      const deltaLogical = logical - startLogical;
      const deltaPrice = price - startPrice;

      if (drawing.type === "hline") {
        drawing.points[0].price = origPoints[0].price + deltaPrice;
        drawing.points[0].time = time;
      } else if (drawing.type === "vline") {
        const origL =
          origPoints[0].logical ?? this.logicalOf(origPoints[0].time);
        if (origL != null) {
          drawing.points[0].time = this.timeOfLogical(origL + deltaLogical);
          drawing.points[0].price = price;
        }
      } else {
        for (let i = 0; i < drawing.points.length; i++) {
          const orig = origPoints[i];
          const origL = orig.logical ?? this.logicalOf(orig.time);
          if (origL != null) {
            const newL = origL + deltaLogical;
            const newTime = this.timeOfLogical(newL);
            const newPrice = orig.price + deltaPrice;
            drawing.points[i] = { ...orig, time: newTime, price: newPrice };
          }
        }
      }
      this.drawings.update();
    }
  }

  // ---------- live updates ----------
  startLive() {
    this.stopLive();
    if (this.replay || !this.bars.length) return;
    if (this.forcePollingUntil > Date.now()) return this.poll();
    this.forcePollingUntil = 0;
    const ex = exchange(this.cfg.symbol);
    const wsTf = BINANCE_WS_TF[this.cfg.tf];
    if ((ex === "BINANCE" && this.provider === "Binance" || ex === "BINANCE_FUTURES" && this.provider === "Binance Futures") && wsTf)
      this.openSocket(ticker(this.cfg.symbol).toLowerCase(), wsTf, 0);
    else this.poll();
  }

  openSocket(sym, interval, hostIdx) {
    const hosts = exchange(this.cfg.symbol) === "BINANCE_FUTURES" ? ["wss://fstream.binance.com/ws/"] : [
      "wss://stream.binance.com:9443/ws/",
      "wss://data-stream.binance.vision/ws/",
    ];
    if (hostIdx >= hosts.length) return this.poll();
    let opened = false;
    let lastMessageAt = Date.now();
    const ws = new WebSocket(`${hosts[hostIdx]}${sym}@kline_${interval}`);
    this.ws = ws;
    clearTimeout(this.wsConnectTimer);
    this.wsConnectTimer = setTimeout(() => {
      if (this.ws === ws && !opened) ws.close();
    }, 5000);
    const armWatchdog = () => {
      clearTimeout(this.wsWatchTimer);
      this.wsWatchTimer = setTimeout(() => {
        if (this.ws !== ws || Date.now() - lastMessageAt < 5000) return;
        // A socket can stay "open" while its feed has stopped. Fall back to HTTP briefly,
        // then try the live stream again.
        this.forcePollingUntil = Date.now() + 30000;
        this.stopLive();
        this.poll();
      }, 5000);
    };
    ws.onopen = () => {
      opened = true;
      clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
      lastMessageAt = Date.now();
      armWatchdog();
      this.pollSocketFeed();
      this.app.setStatus("ok");
    };
    ws.onmessage = (m) => {
      lastMessageAt = Date.now();
      armWatchdog();
      const k = JSON.parse(m.data).k;
      if (k)
        this.merge([
          {
            time: k.t / 1000,
            open: +k.o,
            high: +k.h,
            low: +k.l,
            close: +k.c,
            volume: +k.v,
          },
        ]);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
      clearTimeout(this.wsWatchTimer);
      this.wsWatchTimer = null;
      this.stopSocketFeed();
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) this.openSocket(sym, interval, hostIdx + 1);
      else this.liveTimer = setTimeout(() => this.startLive(), 1000);
    };
  }

  // Keep reconciling with the app's HTTP candle feed while the socket is open.
  // This covers browser networks where the WebSocket stays open but its values stall.
  pollSocketFeed() {
    this.stopSocketFeed();
    const socket = this.ws;
    const symbol = this.cfg.symbol;
    const tf = this.cfg.tf;
    const getDelay = () => (this.app.active === this ? 500 : 1500);
    const tick = async () => {
      if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN || this.replay) return;
      try {
        const r = await api.candles(symbol, tf, 5);
        if (this.ws === socket && socket.readyState === WebSocket.OPEN && !this.replay) this.merge(r.candles);
      } catch {
        /* the WebSocket can continue while HTTP retries on its next tick */
      }
      if (this.ws === socket && socket.readyState === WebSocket.OPEN && !this.replay) {
        this.wsPollTimer = setTimeout(tick, getDelay());
      }
    };
    this.wsPollTimer = setTimeout(tick, getDelay());
  }

  stopSocketFeed() {
    clearTimeout(this.wsPollTimer);
    this.wsPollTimer = null;
  }

  poll() {
    const crypto = ["BINANCE", "BINANCE_FUTURES", "COINBASE", "KRAKEN"].includes(
      exchange(this.cfg.symbol),
    );
    const getDelay = () => {
      const active = this.app.active === this;
      return crypto ? (active ? 200 : 500) : (active ? 1000 : 2000);
    };
    const tick = async () => {
      if (this.replay || !this.liveTimer) return;
      try {
        const r = await api.candles(this.cfg.symbol, this.cfg.tf, 5);
        if (this.replay || !this.liveTimer) return;
        this.merge(r.candles);
      } catch {
        /* keep trying */
      }
      if (this.replay || !this.liveTimer) return;
      if (this.forcePollingUntil && Date.now() >= this.forcePollingUntil) {
        this.forcePollingUntil = 0;
        this.startLive();
        return;
      }
      this.liveTimer = setTimeout(tick, getDelay());
    };
    this.liveTimer = setTimeout(tick, 0);
  }

  stopLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    clearTimeout(this.wsWatchTimer);
    this.wsWatchTimer = null;
    clearTimeout(this.wsConnectTimer);
    this.wsConnectTimer = null;
    this.stopSocketFeed();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  merge(newBars) {
    if (!this.bars.length || this.replay) return;
    const currentLast = this.bars.at(-1);
    const continuousMarket = ["BINANCE", "BINANCE_FUTURES", "COINBASE", "KRAKEN"].includes(
      exchange(this.cfg.symbol),
    );
    const interval = parseTf(this.cfg.tf).seconds;
    const futureBars = newBars.filter((b) => b.time > currentLast.time);
    if (
      continuousMarket &&
      futureBars.some((b) => b.time > currentLast.time + interval)
    ) this.backfillLiveGap(currentLast.time, Math.max(...futureBars.map((b) => b.time)));
    let changed = false;
    for (const b of newBars) {
      const last = this.bars.at(-1);
      if (b.time === last.time) {
        this.bars[this.bars.length - 1] = b;
        changed = true;
      } else if (b.time > last.time) {
        this.bars.push(b);
        changed = true;
      }
    }
    if (!changed) return;
    const last = this.bars.at(-1);
    this.app.onPrice(this.cfg.symbol, last.close);
    const simple = [
      "candles",
      "hollow",
      "bars",
      "line",
      "linemarkers",
      "step",
      "area",
      "baseline",
      "columns",
    ].includes(this.cfg.type);
    if (simple) {
      this.shown = this.bars;
      if (this.times.at(-1) !== this.toChart(last.time))
        this.times.push(this.toChart(last.time));
      this.main.update(this.pointFor(last));
      this.volume?.update(this.volPoint(last));
      this.updateLivePrice(last);
    }
    const now = Date.now();
    if (now - (this.mtfCheckedAt || 0) > 60000) {
      this.mtfCheckedAt = now;
      for (const [tf, h] of Object.entries(this.mtf || {})) if (now - h.at > 60000) this.loadMtf(tf);
    }
    const active = this.app.active === this;
    if (simple && this.cfg.indicators?.length && now - (this.lastFull || 0) > (active ? 200 : 1000)) {
      this.lastFull = now;
      this.renderIndicators();
      this.updateLegend();
    } else if (!simple && now - (this.lastFull || 0) > (active ? 200 : 1000)) {
      this.lastFull = now;
      this.render(false);
    }
  }

  async backfillLiveGap(fromTime, throughTime) {
    if (this.gapFillPending) return;
    const symbol = this.cfg.symbol;
    const tf = this.cfg.tf;
    const token = this.loadToken;
    const interval = parseTf(tf).seconds;
    const gapBars = Math.ceil((throughTime - fromTime) / interval) - 1;
    const limit = Math.min(
      20000,
      Math.max(10, gapBars + 5),
      this.app.settings.bars || 3000,
    );
    this.gapFillPending = true;
    try {
      const r = await api.candles(symbol, tf, limit);
      if (token !== this.loadToken || symbol !== this.cfg.symbol || tf !== this.cfg.tf) return;
      const latestTime = this.bars.at(-1)?.time;
      const byTime = new Map(this.bars.map((bar) => [bar.time, bar]));
      for (const bar of r.candles) {
        // Preserve the latest live candle in case REST returned an older cached value.
        if (bar.time < latestTime) byTime.set(bar.time, bar);
      }
      const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (merged.length === this.bars.length) return;
      this.bars = merged;
      this.provider = r.provider || this.provider;
      this.render(false);
      this.app.onPrice(this.cfg.symbol, this.bars.at(-1).close);
    } catch {
      /* continue live updates; the next missed interval can retry the backfill */
    } finally {
      this.gapFillPending = false;
    }
  }

  // ---------- bar replay ----------
  startReplay(index) {
    this.stopLive();
    this.replay = {
      index: Math.max(1, Math.min(index, this.bars.length - 1)),
      playing: false,
      speed: 2,
    };
    let bar = this.el.querySelector(".replay-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "replay-bar";
      bar.innerHTML = `<span class="hint">Replay</span>
        <button data-r="back" title="Step back">&#9664;&#9664;</button>
        <button data-r="play" title="Play / pause">&#9654;</button>
        <button data-r="fwd" title="Step forward">&#9654;&#9654;</button>
        <select data-r="speed" title="Speed"><option value="0.5">0.5x</option><option value="1">1x</option><option value="2" selected>2x</option><option value="5">5x</option><option value="10">10x</option></select>
        <button data-r="pick" title="Pick a new start bar">Jump to…</button>
        ${this.app.panes.length > 1 ? `<label class="hint" title="Replay every chart in the layout to the same moment"><input type="checkbox" data-r="sync" ${this.app.settings.syncReplay ? "checked" : ""}> All charts</label>` : ""}
        <button data-r="exit" title="Back to live">Exit</button>`;
      this.el.appendChild(bar);
      bar.addEventListener("click", (e) => {
        const r = e.target.closest("[data-r]")?.dataset.r;
        if (r === "back") this.replayStep(-1);
        if (r === "fwd") this.replayStep(1);
        if (r === "play") this.toggleReplay();
        if (r === "pick") this.app.setTool("replay-pick");
        if (r === "exit") this.stopReplay();
      });
      const sync = bar.querySelector('[data-r="sync"]');
      if (sync)
        sync.onchange = (e) => {
          this.app.settings.syncReplay = e.target.checked;
          this.app.persist();
          if (e.target.checked) this.app.onReplayStart?.(this);
          else this.app.onReplayStop?.(this, { keepSelf: true });
        };
      bar.querySelector('[data-r="speed"]').onchange = (e) => {
        this.replay.speed = Number(e.target.value);
        if (this.replay.playing) {
          this.toggleReplay();
          this.toggleReplay();
        }
      };
    }
    this.render(false);
    this.app.onReplayStart?.(this);
  }

  // Follow another chart's replay: show only the bars that had finished by `endTime`.
  replayTo(endTime) {
    const sec = parseTf(this.cfg.tf).seconds;
    let i = this.bars.length - 1;
    while (i > 0 && this.bars[i].time + sec > endTime) i--;
    if (!this.replay) {
      this.stopLive();
      this.replay = { index: i, playing: false, speed: 2, follower: true };
      this.el.querySelector(".replay-bar")?.remove();
      const tag = document.createElement("div");
      tag.className = "replay-bar follower";
      tag.innerHTML = '<span class="hint">Synced replay</span>';
      this.el.appendChild(tag);
    } else this.replay.index = i;
    this.render(false);
  }

  replayStep(dir) {
    if (!this.replay) return;
    const next = this.replay.index + dir;
    if (next < 1 || next >= this.bars.length) {
      if (this.replay.playing) this.toggleReplay();
      return;
    }
    this.replay.index = next;
    this.render(false);
    this.app.onReplayBar?.(this, this.bars[next]);
  }

  toggleReplay() {
    if (!this.replay) return;
    this.replay.playing = !this.replay.playing;
    clearInterval(this.replayTimer);
    if (this.replay.playing)
      this.replayTimer = setInterval(
        () => this.replayStep(1),
        1000 / this.replay.speed,
      );
    const btn = this.el.querySelector('[data-r="play"]');
    if (btn)
      btn.innerHTML = this.replay.playing ? "&#10074;&#10074;" : "&#9654;";
  }

  stopReplay() {
    clearInterval(this.replayTimer);
    const wasFollower = this.replay?.follower;
    this.replay = null;
    this.el.querySelector(".replay-bar")?.remove();
    this.render(true);
    this.startLive();
    if (!wasFollower) this.app.onReplayStop?.(this);
  }

  // ---------- export ----------
  screenshot() {
    const canvas = this.chart.takeScreenshot(true);
    const ctx = canvas.getContext("2d");
    ctx.font = "600 14px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = css("--text");
    ctx.fillText(`${ticker(this.cfg.symbol)} · ${this.cfg.tf}`, 12, 22);
    return canvas;
  }

  destroy() {
    this.clearTradeOverlay(false);
    this.loadToken = {};
    this.stopLive();
    if (this.dragCleanup) this.dragCleanup();
    clearInterval(this.countdownTimer);
    clearInterval(this.replayTimer);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("focus", this.onWindowFocus);
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("pagehide", this.onPageHide);
    this.chart.remove();
  }
}
