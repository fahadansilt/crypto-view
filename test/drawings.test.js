import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrawingLayer } from '../public/js/drawings.js';

function mockPane() {
  const times = [100, 200, 300, 400, 500];
  return {
    cfg: { hideDrawings: false },
    timeToX(t) {
      // Mock linear mapping: t = 100 -> 10, t = 500 -> 410
      return 10 + (t - 100);
    },
    series: {
      priceToCoordinate(p) {
        // Mock linear mapping: p = 100 -> 200, p = 200 -> 100
        return 300 - p;
      },
    },
    chart: {
      timeScale() {
        return {
          width: () => 600,
          coordinateToLogical: (x) => (x - 10) / 100,
        };
      },
      panes() {
        return [{ getHeight: () => 400 }];
      },
    },
    logicalOf(t) {
      return (t - 100) / 100;
    },
    timeOfLogical(l) {
      return 100 + l * 100;
    },
    formatPrice(p) {
      return String(p);
    },
  };
}

test('DrawingLayer: handles for trend line', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const trend = {
    id: '1',
    type: 'trend',
    points: [
      { time: 150, price: 50 },
      { time: 350, price: 150 },
    ],
  };
  layer.setItems([trend]);
  layer.selected = trend;

  const handles = layer.getHandles(trend);
  assert.equal(handles.length, 2);
  assert.equal(handles[0].index, 0);
  assert.equal(handles[0].x, pane.timeToX(150));
  assert.equal(handles[0].y, pane.series.priceToCoordinate(50));
  assert.equal(handles[1].index, 1);
  assert.equal(handles[1].x, pane.timeToX(350));
  assert.equal(handles[1].y, pane.series.priceToCoordinate(150));

  // Hit test handle
  const hit0 = layer.hitTestHandle(handles[0].x + 2, handles[0].y - 2);
  assert.ok(hit0);
  assert.equal(hit0.index, 0);
  assert.equal(hit0.drawing, trend);

  const hitNone = layer.hitTestHandle(handles[0].x + 50, handles[0].y + 50);
  assert.equal(hitNone, null);
});

test('DrawingLayer: handles for horizontal line stay visible on screen', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  // Time is 5000 (way offscreen, x would be 4910)
  const hline = {
    id: '2',
    type: 'hline',
    points: [{ time: 5000, price: 120 }],
  };
  layer.setItems([hline]);
  layer.selected = hline;

  const handles = layer.getHandles(hline);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].index, 0);
  // Visible handle centered horizontally
  assert.equal(handles[0].x, 300);
  assert.equal(handles[0].y, pane.series.priceToCoordinate(120));

  // Hit test along the horizontal line
  const hitLine = layer.hitTest(150, pane.series.priceToCoordinate(120) + 2);
  assert.equal(hitLine, hline);
});

test('DrawingLayer: handles for rectangle provide 4 corner handles', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const rect = {
    id: '3',
    type: 'rect',
    points: [
      { time: 100, price: 100 },
      { time: 300, price: 200 },
    ],
  };
  layer.setItems([rect]);
  layer.selected = rect;

  const handles = layer.getHandles(rect);
  assert.equal(handles.length, 4);
  assert.deepEqual(
    handles.map((h) => h.role),
    ['corner-a', 'corner-b', 'corner-b-x-a-y', 'corner-a-x-b-y'],
  );
});

test('DrawingLayer: handles for parallel channel', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const channel = {
    id: '4',
    type: 'channel',
    points: [
      { time: 100, price: 100 },
      { time: 300, price: 150 },
      { time: 200, price: 80 },
    ],
  };
  layer.setItems([channel]);
  layer.selected = channel;

  const handles = layer.getHandles(channel);
  assert.equal(handles.length, 3);
  assert.equal(handles[2].index, 2);

  // Line hit test works on both baseline and parallel line
  const hitBaseline = layer.hitTest(pane.timeToX(200), pane.series.priceToCoordinate(125));
  assert.equal(hitBaseline, channel);
});

test('DrawingLayer: handles and hit test for fib retracement', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const fib = {
    id: '5',
    type: 'fib',
    points: [
      { time: 100, price: 100 },
      { time: 300, price: 200 },
    ],
  };
  layer.setItems([fib]);
  layer.selected = fib;

  const handles = layer.getHandles(fib);
  assert.equal(handles.length, 2);
  assert.equal(handles[0].index, 0);
  assert.equal(handles[1].index, 1);

  // Handle hit test
  const hitHandle = layer.hitTestHandle(handles[0].x, handles[0].y);
  assert.ok(hitHandle);
  assert.equal(hitHandle.index, 0);

  // Hit test on diagonal line
  const hitDiag = layer.hitTest(pane.timeToX(200), pane.series.priceToCoordinate(150));
  assert.equal(hitDiag, fib);

  // Hit test on a fib level (e.g. 0.5 level: price = 200 + (100 - 200)*0.5 = 150)
  const hitLevel = layer.hitTest(pane.timeToX(150), pane.series.priceToCoordinate(150));
  assert.equal(hitLevel, fib);
});

test('DrawingLayer: handles and hit test for long and short position', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const longPos = {
    id: '6',
    type: 'long',
    points: [
      { time: 100, price: 100 },
      { time: 300, price: 90 },
    ],
  };
  layer.setItems([longPos]);
  layer.selected = longPos;

  const handles = layer.getHandles(longPos);
  assert.equal(handles.length, 2);

  // Hit test inside the position box
  const hit = layer.hitTest(pane.timeToX(200), pane.series.priceToCoordinate(105));
  assert.equal(hit, longPos);
});

test('DrawingLayer: handles and hit test for vline and measure', () => {
  const pane = mockPane();
  const layer = new DrawingLayer(pane);
  layer.attached({ series: pane.series, requestUpdate: () => {} });

  const vline = {
    id: '7',
    type: 'vline',
    points: [{ time: 200, price: 100 }],
  };
  const measure = {
    id: '8',
    type: 'measure',
    points: [
      { time: 100, price: 100 },
      { time: 300, price: 150 },
    ],
  };
  layer.setItems([vline, measure]);

  // Vline hit test
  const hitV = layer.hitTest(pane.timeToX(200) + 2, 200);
  assert.equal(hitV, vline);

  // Measure hit test inside box (away from the vertical line at time 200)
  const hitM = layer.hitTest(pane.timeToX(250), pane.series.priceToCoordinate(120));
  assert.equal(hitM, measure);
});
