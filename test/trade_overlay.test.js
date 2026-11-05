import test from "node:test";
import assert from "node:assert/strict";

// Helper replicating ChartPane.prototype.snapToBar
function snapToBar(utcSec, bars) {
  if (!utcSec) return null;
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

// Helper replicating App.prototype.matchTradeSymbol
function matchTradeSymbol(tradePair, chartSymbol) {
  if (!tradePair || !chartSymbol) return false;
  const clean = (s) =>
    String(s)
      .trim()
      .replace(/^[A-Z0-9_]+:/i, "")
      .replace(/:[A-Z0-9]+$/i, "")
      .replace(/[:/_\s]/g, "")
      .replace(/\.P$/i, "")
      .toUpperCase();
  return clean(tradePair) === clean(chartSymbol);
}

// Helper replicating marker generation in applyTradeOverlay
function buildTradeMarkers(trade, snapFn) {
  const isShort = trade.side === "short" || trade.side === "Short" || trade.is_short;
  const markers = [];

  const entryTime = snapFn(trade.openTime || (trade.entries && trade.entries[0]?.time));
  const entryPrice = trade.entry != null ? trade.entry : (trade.entries && trade.entries[0]?.price);
  if (entryTime && entryPrice != null) {
    markers.push({
      time: entryTime,
      position: isShort ? "aboveBar" : "belowBar",
      color: isShort ? "#f97316" : "#3b82f6",
      shape: isShort ? "arrowDown" : "arrowUp",
      text: `ENTRY @ ${entryPrice}`,
    });
  }

  const entries = Array.isArray(trade.entries) ? trade.entries : [];
  const dcaEntries = entries.length > 1 ? entries.slice(1) : [];
  dcaEntries.forEach((e, idx) => {
    const t = snapFn(e.time);
    if (t && e.price != null) {
      markers.push({
        time: t,
        position: isShort ? "aboveBar" : "belowBar",
        color: "#0ea5e9",
        shape: "square",
        text: `+DCA #${e.index || idx + 2} @ ${e.price}`,
      });
    }
  });

  const grindExits = Array.isArray(trade.grindExits) ? trade.grindExits : [];
  grindExits.forEach((g, idx) => {
    const t = snapFn(g.time);
    if (t && g.price != null) {
      markers.push({
        time: t,
        position: isShort ? "belowBar" : "aboveBar",
        color: "#f59e0b",
        shape: "circle",
        text: `GRIND EXIT #${g.index || idx + 1} @ ${g.price}`,
      });
    }
  });

  const exitTime = snapFn(trade.closeTime);
  const exitPrice = trade.exit != null ? trade.exit : (trade.exits && trade.exits[trade.exits.length - 1]?.price);
  if (!trade.isOpen && exitTime && exitPrice != null) {
    const isWin = (trade.profitRatio != null ? trade.profitRatio >= 0 : (trade.profit != null ? trade.profit >= 0 : true));
    const pnlPct = trade.profitRatio != null
      ? `${trade.profitRatio >= 0 ? "+" : ""}${(trade.profitRatio * 100).toFixed(2)}%`
      : "";
    markers.push({
      time: exitTime,
      position: isShort ? "belowBar" : "aboveBar",
      color: isWin ? "#10b981" : "#ef4444",
      shape: "circle",
      text: `EXIT @ ${exitPrice}${pnlPct ? ` (${pnlPct})` : ""}`,
    });
  }

  return markers;
}

test("snapToBar: correctly snaps timestamps to containing or nearest bars", () => {
  const bars = [
    { time: 1700000000 },
    { time: 1700000300 }, // +5m
    { time: 1700000600 }, // +5m
    { time: 1700000900 }, // +5m
  ];

  // Exact match
  assert.equal(snapToBar(1700000300, bars), 1700000300);

  // Time in between bars snaps to bar open (bTime <= utc < nextTime)
  assert.equal(snapToBar(1700000450, bars), 1700000300);
  assert.equal(snapToBar(1700000599, bars), 1700000300);
  assert.equal(snapToBar(1700000601, bars), 1700000600);

  // Before first bar clamps to first
  assert.equal(snapToBar(1699999000, bars), 1700000000);

  // After last bar clamps to last
  assert.equal(snapToBar(1700002000, bars), 1700000900);
});

test("matchTradeSymbol: correctly correlates dash, slash, and exchange prefixes", () => {
  assert.equal(matchTradeSymbol("PHA/USDT", "BINANCE_FUTURES:PHAUSDT"), true);
  assert.equal(matchTradeSymbol("BTC/USDT:USDT", "BINANCE:BTCUSDT"), true);
  assert.equal(matchTradeSymbol("ETH/USDT", "ETHUSDT.P"), true);
  assert.equal(matchTradeSymbol("SOL/USDT", "BINANCE_FUTURES:PHAUSDT"), false);
});

test("Trade Overlay: builds initial entry, DCA entries, grinding exits and exit markers", () => {
  const bars = [
    { time: 1000 },
    { time: 1300 },
    { time: 1600 },
    { time: 1900 },
  ];
  const snap = (t) => snapToBar(t, bars);

  const longTrade = {
    id: 42,
    pair: "PHA/USDT",
    side: "long",
    entry: 0.0375,
    openTime: 1050,
    isOpen: false,
    closeTime: 1920,
    exit: 0.0390,
    profitRatio: 0.04,
    entries: [
      { index: 1, time: 1050, price: 0.0375 },
      { index: 2, time: 1320, price: 0.0360 },
    ],
    grindExits: [
      { index: 1, time: 1650, price: 0.0382 },
    ],
  };

  const markers = buildTradeMarkers(longTrade, snap);
  assert.equal(markers.length, 4);

  // Initial Entry
  assert.equal(markers[0].time, 1000);
  assert.equal(markers[0].position, "belowBar");
  assert.equal(markers[0].shape, "arrowUp");
  assert.equal(markers[0].color, "#3b82f6");

  // DCA Entry
  assert.equal(markers[1].time, 1300);
  assert.equal(markers[1].position, "belowBar");
  assert.equal(markers[1].shape, "square");
  assert.equal(markers[1].text, "+DCA #2 @ 0.036");

  // Grind Exit
  assert.equal(markers[2].time, 1600);
  assert.equal(markers[2].position, "aboveBar");
  assert.equal(markers[2].shape, "circle");
  assert.equal(markers[2].color, "#f59e0b");

  // Final Close
  assert.equal(markers[3].time, 1900);
  assert.equal(markers[3].position, "aboveBar");
  assert.equal(markers[3].color, "#10b981");
  assert.equal(markers[3].text, "EXIT @ 0.039 (+4.00%)");
});

test("Trade Overlay: short trade inverts entry and exit marker positions", () => {
  const bars = [{ time: 1000 }, { time: 2000 }];
  const snap = (t) => snapToBar(t, bars);

  const shortTrade = {
    pair: "BTC/USDT",
    side: "short",
    entry: 77000,
    openTime: 1000,
    isOpen: true,
  };

  const markers = buildTradeMarkers(shortTrade, snap);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].position, "aboveBar");
  assert.equal(markers[0].shape, "arrowDown");
  assert.equal(markers[0].color, "#f97316");
});
