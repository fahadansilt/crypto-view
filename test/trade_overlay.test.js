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
      text: `ENTRY @ ${entryPrice}${entryStakeStr}`,
    });
  }

  const entries = Array.isArray(trade.entries) ? trade.entries : [];
  const dcaEntries = entries.length > 1 ? entries.slice(1) : [];
  dcaEntries.forEach((e, idx) => {
    const t = snapFn(e.time);
    if (t && e.price != null) {
      const stk = e.stake != null
        ? Number(e.stake)
        : (e.amount != null ? Number(e.amount) * Number(e.price) : null);
      const stkStr = stk != null ? ` (+$${stk >= 10 ? Math.round(stk) : stk.toFixed(1)})` : "";
      markers.push({
        time: t,
        position: isShort ? "aboveBar" : "belowBar",
        color: "#0ea5e9",
        shape: "square",
        text: `+DCA #${e.index || idx + 2} @ ${e.price}${stkStr}`,
      });
    }
  });

  const grindExits = Array.isArray(trade.grindExits) ? trade.grindExits : [];
  grindExits.forEach((g, idx) => {
    const t = snapFn(g.time);
    if (t && g.price != null) {
      const stk = (g.price != null && g.amount != null) ? Number(g.price) * Number(g.amount) : null;
      const stkStr = stk != null ? ` (-$${stk >= 10 ? Math.round(stk) : stk.toFixed(1)})` : "";
      markers.push({
        time: t,
        position: isShort ? "belowBar" : "aboveBar",
        color: "#f59e0b",
        shape: "circle",
        text: `GRIND EXIT #${g.index || idx + 1} @ ${g.price}${stkStr}`,
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

// Helper replicating ChartPane.prototype.buildOrderLedger
function buildOrderLedger(trade) {
  const list = [];
  const entries = Array.isArray(trade.entries) ? trade.entries : [];
  const grindExits = Array.isArray(trade.grindExits) ? trade.grindExits : [];
  const exits = Array.isArray(trade.exits) ? trade.exits : [];

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

  list.sort((a, b) => (a.time || 0) - (b.time || 0));

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

test("Trade Overlay: buildOrderLedger calculates chronological execution ledger, running stake and peak exposure", () => {
  const trade = {
    id: 99,
    pair: "PHA/USDT",
    side: "long",
    entry: 0.0375,
    openTime: 1000,
    isOpen: true,
    entries: [
      { index: 1, time: 1000, price: 0.0375, amount: 1333.33, stake: 50 },
      { index: 2, time: 1200, price: 0.0360, amount: 2083.33, stake: 75 },
    ],
    grindExits: [
      { index: 1, time: 1400, price: 0.0372, amount: 672.04 }, // 672.04 * 0.0372 = 25
    ],
  };

  const { orders, maxStake, currentStake } = buildOrderLedger(trade);
  assert.equal(orders.length, 3);
  assert.equal(orders[0].label, "Initial Entry");
  assert.equal(orders[0].cumStake, 50);

  assert.equal(orders[1].label, "DCA #2");
  assert.equal(orders[1].cumStake, 125);

  assert.equal(orders[2].label, "Grind Exit #1");
  assert.ok(orders[2].cumStake < 125);
  assert.equal(Math.round(maxStake), 125);
  assert.equal(Math.round(currentStake), 100);
});
