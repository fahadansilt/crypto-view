// TradingView-style chart shortcuts. One registry drives both key handling and the help list.
import { esc, ticker } from "./api.js";
import { parseTf } from "../lib/series.js";

export function matchesShortcut(event, chord) {
  const parts = chord === "+" ? [] : chord.endsWith("++") ? chord.slice(0, -2).split("+") : chord.split("+");
  const key = chord.endsWith("+") ? "+" : parts.pop();
  const mod = parts.includes("Mod");
  // Option changes the printed character on Mac; use the physical key for modified letters.
  const actual = event.altKey && /^Key[A-Z]$/.test(event.code || "") ? event.code.slice(3) : event.key;
  return actual.toLowerCase() === key.toLowerCase() &&
    !!(event.ctrlKey || event.metaKey) === mod &&
    !!event.altKey === parts.includes("Alt") &&
    !!event.shiftKey === parts.includes("Shift");
}

export function isEditing(target) {
  return !!(target?.isContentEditable || target?.closest?.("input, textarea, select, [role='textbox'], [contenteditable]:not([contenteditable='false'])"));
}

// Only chart configuration is undoable: paper trades and alerts are never rewound.
export class ChartHistory {
  constructor(read, apply, limit = 50) {
    this.read = read;
    this.apply = apply;
    this.limit = limit;
    this.entries = [JSON.stringify(read())];
    this.index = 0;
    this.restoring = false;
  }
  record() {
    if (this.restoring) return;
    const value = JSON.stringify(this.read());
    if (value === this.entries[this.index]) return;
    this.entries.splice(this.index + 1);
    this.entries.push(value);
    if (this.entries.length > this.limit + 1) this.entries.shift();
    this.index = this.entries.length - 1;
  }
  move(direction) {
    const next = this.index + direction;
    if (next < 0 || next >= this.entries.length) return false;
    this.index = next;
    this.restoring = true;
    try { this.apply(JSON.parse(this.entries[this.index])); }
    finally { this.restoring = false; }
    return true;
  }
}

export class ChartShortcuts {
  constructor(app) {
    this.app = app;
    this.clipboard = null;
    const click = (id) => () => document.getElementById(id)?.click();
    const tool = (id) => () => app.setTool(id);
    const type = (id) => () => {
      app.active.cfg.type = id;
      app.active.render(true);
      app.syncToolbar();
      app.persist();
    };
    const add = (group, label, keys, run, when = () => true) => ({ group, label, keys, run, when });
    const replay = () => !!app.active?.replay && !app.active.replay.follower;
    this.actions = [
      add("General", "Keyboard shortcuts", ["?", "Shift+?", "Mod+/"], () => this.showHelp()),
      add("General", "Symbol search", ["Mod+k"], () => app.openSymbolSearch()),
      add("General", "Indicators", ["/"], () => app.openIndicatorPicker()),
      add("General", "Change interval", [","], () => this.openInterval()),
      add("General", "Create alert", ["Alt+a"], click("alertBtn")),
      add("General", "Save chart layout", ["Mod+s"], () => { app.persist(); app.toast("Chart layout saved."); }),
      add("General", "Undo chart change", ["Mod+z"], () => { if (!app.history.move(-1)) app.toast("Nothing to undo."); }),
      add("General", "Redo chart change", ["Mod+y", "Mod+Shift+z"], () => { if (!app.history.move(1)) app.toast("Nothing to redo."); }),
      add("Drawing tools", "Trend line", ["Alt+t"], tool("trend")),
      add("Drawing tools", "Price range / measure", [" "], tool("measure")),
      add("Drawing tools", "Horizontal line", ["Alt+h"], tool("hline")),
      add("Drawing tools", "Vertical line", ["Alt+v"], tool("vline")),
      add("Drawing tools", "Ray", ["Alt+j"], tool("ray")),
      add("Drawing tools", "Fib retracement", ["Alt+f"], tool("fib")),
      add("Drawing tools", "Text note", ["Alt+x"], tool("text")),
      add("Drawing tools", "Rectangle", ["Alt+Shift+r"], tool("rect")),
      add("Drawing tools", "Long position", ["Alt+Shift+l"], tool("long")),
      add("Drawing tools", "Short position", ["Alt+Shift+s"], tool("short")),
      add("Drawing tools", "Delete selected drawing", ["Delete", "Backspace"], () => app.active.deleteSelectedDrawing()),
      add("Drawing tools", "Copy selected drawing", ["Mod+c"], () => this.copyDrawing(), () => !!app.active?.drawings.selected),
      add("Drawing tools", "Cut selected drawing", ["Mod+x"], () => { this.copyDrawing(); app.active.deleteSelectedDrawing(); }, () => !!app.active?.drawings.selected),
      add("Drawing tools", "Paste drawing", ["Mod+v"], () => this.pasteDrawing(), () => !!this.clipboard),
      add("Drawing tools", "Hide / show drawings", ["Mod+Alt+h"], () => {
        const p = app.active;
        p.cfg.hideDrawings = !p.cfg.hideDrawings;
        p.drawings.update();
        app.persist();
      }),
      add("Drawing tools", "Hide / show indicators", ["Mod+Alt+i"], () => {
        const p = app.active;
        p.cfg.hideIndicators = !p.cfg.hideIndicators;
        p.render(false);
        app.persist();
      }),
      add("Chart view", "Reset chart view / auto scale", ["Alt+r"], () => this.resetView()),
      add("Chart view", "Logarithmic scale", ["Alt+l"], click("logBtn")),
      add("Chart view", "Percentage scale", ["Alt+p"], () => this.toggleScale("percent")),
      add("Chart view", "Invert price scale", ["Alt+i"], () => this.toggleScale("invert")),
      add("Chart view", "Download chart image", ["Alt+s", "Mod+Alt+s"], click("snapBtn")),
      add("Chart view", "Go to date", ["Alt+g"], () => this.goToDate()),
      add("Chart view", "Zoom in", ["=", "Shift++", "+"], () => this.zoom(0.8)),
      add("Chart view", "Zoom out", ["-"], () => this.zoom(1.25)),
      add("Chart view", "Move chart left", ["ArrowLeft"], () => this.pan(-1)),
      add("Chart view", "Move chart right", ["ArrowRight"], () => this.pan(1)),
      add("Chart view", "Move one screen left", ["Mod+ArrowLeft"], () => this.pan(-1, true)),
      add("Chart view", "Move one screen right", ["Mod+ArrowRight"], () => this.pan(1, true)),
      add("Chart view", "First loaded bar", ["Home"], () => this.edge(false)),
      add("Chart view", "Latest bar", ["End"], () => this.edge(true)),
      add("Chart view", "Maximize / restore active chart", ["Alt+Enter"], () => this.maximize()),
      add("Chart view", "Chart fullscreen", ["Shift+f"], () => document.body.classList.toggle("chart-fullscreen")),
      add("Chart type", "Bars", ["Alt+1"], type("bars")),
      add("Chart type", "Candles", ["Alt+2"], type("candles")),
      add("Chart type", "Line", ["Alt+3"], type("line")),
      add("Chart type", "Area", ["Alt+4"], type("area")),
      add("Chart type", "Heikin Ashi", ["Alt+5"], type("heikin")),
      add("Chart type", "Hollow candles", ["Alt+6"], type("hollow")),
      add("Chart type", "Baseline", ["Alt+7"], type("baseline")),
      add("Navigation", "Next chart", ["Tab"], () => this.nextPane(1), () => app.panes.length > 1 && !document.activeElement?.closest?.("button, a, [tabindex]")),
      add("Navigation", "Previous chart", ["Shift+Tab"], () => this.nextPane(-1), () => app.panes.length > 1 && !document.activeElement?.closest?.("button, a, [tabindex]")),
      add("Navigation", "Next watchlist symbol", ["ArrowDown"], () => this.nextSymbol(1), () => !replay()),
      add("Navigation", "Previous watchlist symbol", ["ArrowUp"], () => this.nextSymbol(-1), () => !replay()),
      add("Navigation", "Add symbol to watchlist", ["Alt+w"], () => this.addToWatchlist()),
      add("Panels", "Watchlist", ["Mod+Alt+w"], () => app.panels.showSide("watchlist")),
      add("Panels", "Alerts", ["Mod+Alt+a"], () => app.panels.showSide("alerts")),
      add("Panels", "Hide / show sidebar", ["Mod+Alt+r"], () => document.body.classList.toggle("hide-sidebar")),
      add("Panels", "Strategy tester", ["Mod+Alt+t"], () => app.panels.showBottom("tester", true)),
      add("Panels", "Indicator editor", ["Mod+Alt+e"], () => app.panels.showBottom("editor", true)),
      add("Panels", "Paper trading", ["Mod+Alt+p"], () => app.panels.showBottom("paper", true)),
      add("Replay", "Start / exit bar replay", ["Shift+r"], click("replayBtn")),
      add("Replay", "Play / pause replay", ["Shift+ "], () => app.active.toggleReplay(), replay),
      add("Replay", "Next replay bar", ["Shift+ArrowRight"], () => app.active.replayStep(1), replay),
      add("Replay", "Previous replay bar", ["Shift+ArrowLeft"], () => app.active.replayStep(-1), replay),
    ];
  }

  bind() {
    document.addEventListener("keydown", (event) => this.handle(event));
    document.getElementById("shortcutsBtn").onclick = () => this.showHelp();
    for (const action of this.actions) {
      const names = { "trend": "Trend line", "measure": "Price range / measure", "hline": "Horizontal line", "vline": "Vertical line", "ray": "Ray", "fib": "Fib retracement", "text": "Text note", "rect": "Rectangle", "long": "Long position", "short": "Short position" };
      for (const [id, label] of Object.entries(names)) {
        if (label === action.label) document.querySelector(`[data-tool="${id}"]`)?.setAttribute("title", `${label} (${this.keyLabel(action.keys[0])})`);
      }
    }
  }

  handle(event) {
    const app = this.app;
    if (event.defaultPrevented || event.isComposing || event.key === "Process") return;
    if (event.key === "Escape") {
      if (!document.getElementById("modal").classList.contains("hidden")) app.closeModal();
      else if (app.tool !== "cursor") { app.pendingAnchor = null; app.setTool("cursor"); }
      else if (document.body.classList.contains("chart-fullscreen")) document.body.classList.remove("chart-fullscreen");
      else if (document.getElementById("grid").classList.contains("maximized")) this.maximize();
      else if (app.active?.drawings.selected) { app.active.drawings.selected = null; app.active.drawings.update(); }
      return;
    }
    if (isEditing(event.target) || isEditing(document.activeElement) || !app.active || !document.getElementById("modal").classList.contains("hidden")) return;
    // Let keyboard users activate a focused button and move through controls normally.
    if ([" ", "Enter"].includes(event.key) && event.target?.closest?.("button, a, [role='button']")) return;
    const action = this.actions.find((a) => a.when() && a.keys.some((key) => matchesShortcut(event, key)));
    if (action) {
      event.preventDefault();
      if (!event.repeat || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "=", "+", "-"].includes(event.key)) action.run();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      this.openInterval(event.key);
    } else if (/^[a-z^]$/i.test(event.key)) {
      event.preventDefault();
      app.openSymbolSearch(event.key.toUpperCase());
    }
  }

  keyLabel(chord) {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
    return chord.replace("Mod", mac ? "Cmd" : "Ctrl").replace("Alt", mac ? "Option" : "Alt")
      .replace(/Arrow/g, "").replace(/\+ $/, "+Space").replace(/^ $/, "Space");
  }

  showHelp() {
    const card = this.app.modal("Keyboard shortcuts", `<input class="search-in" id="shortcutSearch" placeholder="Find a shortcut…" autocomplete="off"><p class="hint-text">TradingView-style keys for this terminal's features. Ctrl becomes Cmd on Mac. Shortcuts pause while you type in a field. Some keys are reserved by your browser or operating system.</p><div class="shortcut-list" id="shortcutList"></div>`, { wide: true });
    const input = card.querySelector("#shortcutSearch");
    const draw = () => {
      const term = input.value.toLowerCase();
      const rows = [...this.actions.map((a) => ({ ...a, keys: a.keys.map((key) => this.keyLabel(key)).filter((key) => !key.includes("Numpad")) })),
        { group: "General", label: "Symbol search", keys: ["Type a letter"] },
        { group: "General", label: "Change interval (minutes by default)", keys: ["Type a number"] },
        { group: "General", label: "Cancel tool / close dialog / restore chart", keys: ["Escape"] }]
        .filter((a) => `${a.group} ${a.label} ${a.keys.join(" ")}`.toLowerCase().includes(term));
      const groups = [...new Set(rows.map((a) => a.group))];
      card.querySelector("#shortcutList").innerHTML = groups.map((group) => `<h4>${esc(group)}</h4>${rows.filter((a) => a.group === group).map((a) => `<div class="shortcut-row"><span>${esc(a.label)}</span><kbd>${esc([...new Set(a.keys)].join(" or "))}</kbd></div>`).join("")}`).join("") || '<p class="hint-text">No matching shortcuts.</p>';
    };
    input.oninput = draw;
    draw();
    input.focus();
  }

  openInterval(initial = "") {
    const card = this.app.modal("Change interval", `<label class="field">Interval<input id="intervalValue" class="search-in" value="${esc(initial)}" placeholder="60, 4h, 1D, 1W…" autocomplete="off"></label><p class="hint-text">Numbers alone mean minutes: 60 = 1h. Use h for hours, D for days, W for weeks, M for months, or s for seconds.</p>`, { foot: '<button class="btn primary" data-apply>Apply</button>' });
    const input = card.querySelector("#intervalValue");
    const apply = () => {
      let tf = input.value.trim();
      if (/^\d+$/.test(tf)) tf += "m";
      tf = tf.replace(/(\d)[dD]$/, "$1D").replace(/(\d)[wW]$/, "$1W").replace(/(\d)H$/, "$1h");
      try { parseTf(tf); } catch (e) { this.app.toast(esc(e.message), "err"); return; }
      this.app.closeModal();
      this.app.setTf(tf);
    };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } };
    card.querySelector("[data-apply]").onclick = apply;
    input.focus();
    input.setSelectionRange(initial.length, initial.length);
  }

  copyDrawing() { this.clipboard = structuredClone(this.app.active.drawings.selected); }
  pasteDrawing() {
    const p = this.app.active;
    const item = structuredClone(this.clipboard);
    item.id = `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const offset = parseTf(p.cfg.tf).seconds * 3;
    item.points.forEach((point) => { point.time += offset; });
    p.drawings.items.push(item);
    p.drawings.selected = item;
    p.drawings.update();
    this.app.saveDrawings(p.cfg.symbol, p.drawings.items);
  }
  toggleScale(name) {
    const p = this.app.active;
    p.cfg[name] = !p.cfg[name];
    if (name === "percent" && p.cfg.percent) p.cfg.log = false;
    p.render(false);
    this.app.syncToolbar();
    this.app.persist();
  }
  resetView() {
    const p = this.app.active;
    p.chart.priceScale("right").applyOptions({ autoScale: true });
    p.chart.timeScale().resetTimeScale();
    p.render(true);
  }
  zoom(factor) {
    const scale = this.app.active.chart.timeScale(), range = scale.getVisibleLogicalRange();
    if (!range) return;
    const width = Math.max(5, Math.min(100000, (range.to - range.from) * factor));
    const center = (range.from + range.to) / 2;
    scale.setVisibleLogicalRange({ from: center - width / 2, to: center + width / 2 });
  }
  pan(direction, screen = false) {
    const scale = this.app.active.chart.timeScale(), range = scale.getVisibleLogicalRange();
    if (!range) return;
    const delta = direction * (screen ? range.to - range.from : 1);
    scale.setVisibleLogicalRange({ from: range.from + delta, to: range.to + delta });
  }
  edge(latest) {
    const p = this.app.active, scale = p.chart.timeScale(), range = scale.getVisibleLogicalRange();
    if (!range) return;
    const width = range.to - range.from, end = latest ? p.shown.length + 8 : width;
    scale.setVisibleLogicalRange({ from: end - width, to: end });
  }
  nextPane(direction) {
    const app = this.app, i = app.panes.indexOf(app.active);
    app.setActive(app.panes[(i + direction + app.panes.length) % app.panes.length]);
  }
  maximize() { document.getElementById("grid").classList.toggle("maximized"); }
  nextSymbol(direction) {
    const app = this.app, list = app.state.watchlists[app.state.activeWatchlist] || [];
    if (!list.length) return;
    const index = list.indexOf(app.active.cfg.symbol);
    const next = index < 0 ? (direction > 0 ? 0 : list.length - 1) : (index + direction + list.length) % list.length;
    app.setSymbol(list[next]);
  }
  addToWatchlist() {
    const app = this.app, list = app.state.watchlists[app.state.activeWatchlist] ||= [];
    if (!list.includes(app.active.cfg.symbol)) list.push(app.active.cfg.symbol);
    app.persist();
    app.panels.showSide("watchlist");
    app.toast(`${esc(ticker(app.active.cfg.symbol))} is on your watchlist.`);
  }
  goToDate() {
    const card = this.app.modal("Go to date", '<label class="field">Date and time (your local time)<input id="goDate" type="datetime-local"></label><p class="hint-text">Choose a date within the history already loaded on this chart. Load more bars in Settings if needed.</p>', { foot: '<button class="btn primary" data-go>Go</button>' });
    const input = card.querySelector("#goDate");
    const go = () => {
      const p = this.app.active, time = new Date(input.value).getTime() / 1000;
      if (!Number.isFinite(time)) return this.app.toast("Choose a date first.", "err");
      if (!p.shown.length || time < p.shown[0].time || time > p.shown.at(-1).time + parseTf(p.cfg.tf).seconds) return this.app.toast("That date is outside the loaded chart history.", "err");
      const logical = p.logicalOf(time), range = p.chart.timeScale().getVisibleLogicalRange();
      const half = range ? (range.to - range.from) / 2 : 80;
      p.chart.timeScale().setVisibleLogicalRange({ from: logical - half, to: logical + half });
      this.app.closeModal();
    };
    card.querySelector("[data-go]").onclick = go;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
    input.focus();
  }
}
