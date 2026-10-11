import test from "node:test";
import assert from "node:assert/strict";
import { toGlobalGraph, folderView, buildDegreeMap, nodeRadius, fitTransform, readOptions } from "../lib/graph-data.mjs";

const sample = {
  nodes: {
    "/": { id: 0, url: "/", title: "Home", home: true, hide: false },
    "/a/": { id: 1, url: "/a/", title: "A &amp; B", group: "škola", hide: false },
    "/secret/": { id: 2, url: "/secret/", title: "Secret", hide: true },
    "/b/": { id: 3, url: "/b/", title: "B", group: "Sněžka" },
    "__folder__/": { id: 4, url: "/a/", title: "📁 /", folder: true, group: "none" },
  },
  links: [
    { source: 0, target: 1 },
    { source: 1, target: 0 },
    { source: 1, target: 2 },
    { source: 2, target: 3 },
    { source: 3, target: 3 },
    { source: 1, target: 3 },
  ],
};

test("toGlobalGraph drops hidden nodes and links touching them", () => {
  const g = toGlobalGraph(sample);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), [0, 1, 3, 4]);
  assert.ok(g.links.every((l) => l.source !== 2 && l.target !== 2));
});

test("toGlobalGraph de-duplicates reverse links and drops self links", () => {
  const g = toGlobalGraph(sample);
  assert.deepEqual(g.links, [
    { source: 0, target: 1 },
    { source: 1, target: 3 },
  ]);
});

test("toGlobalGraph keeps the home flag and only the fields the renderer needs", () => {
  const g = toGlobalGraph(sample);
  const home = g.nodes.find((n) => n.id === 0);
  assert.deepEqual(home, { id: 0, url: "/", title: "Home", home: true, group: "none" });
  assert.equal(g.nodes.find((n) => n.id === 3).home, false);
  assert.equal(g.nodes.find((n) => n.id === 1).group, "škola");
  assert.equal(g.nodes.find((n) => n.id === 3).group, "Sněžka");
  assert.equal(g.nodes.find((n) => n.id === 4).folder, true);
});

test("toGlobalGraph tolerates missing or malformed input", () => {
  assert.deepEqual(toGlobalGraph(null), { nodes: [], links: [] });
  assert.deepEqual(toGlobalGraph({}), { nodes: [], links: [] });
  assert.deepEqual(toGlobalGraph({ nodes: { x: { id: 1, hide: false } } }), {
    nodes: [{ id: 1, url: undefined, title: undefined, home: false, group: "none" }],
    links: [],
  });
});

test("folderView keeps all descendant files and folders but hides unrelated branches and ancestors", () => {
  const graph = {
    nodes: [
      { id: 0, title: "/", folder: true, folderRoot: true, folderPath: "" },
      { id: 1, title: "A", folder: true, folderPath: "A" },
      { id: 2, title: "B", folder: true, folderPath: "A/B" },
      { id: 3, title: "C", folder: true, folderPath: "A/C" },
      { id: 4, title: "deep", folder: true, folderPath: "A/B/deep" },
      { id: 5, title: "root-file", folderPath: "" },
      { id: 6, title: "a-file", folderPath: "A" },
      { id: 7, title: "b-file", folderPath: "A/B" },
      { id: 8, title: "deep-file", folderPath: "A/B/deep" },
    ],
    links: [
      { source: 0, target: 1 }, { source: 1, target: 2 }, { source: 1, target: 3 },
      { source: 2, target: 4 }, { source: 0, target: 5 }, { source: 1, target: 6 },
      { source: 2, target: 7 }, { source: 4, target: 8 },
    ],
  };
  assert.deepEqual(folderView(graph, "A/B").nodes.map((n) => n.id), [0, 2, 4, 7, 8]);
  assert.deepEqual(folderView(graph, "A/B").links, [
    { source: 2, target: 4 }, { source: 2, target: 7 }, { source: 4, target: 8 }, { source: 0, target: 2 },
  ]);
  assert.deepEqual(folderView(graph, "").nodes.map((n) => n.id), [0, 1, 5]);
  assert.deepEqual(folderView(graph, "").links, [
    { source: 0, target: 1 }, { source: 0, target: 5 },
  ]);
});

test("buildDegreeMap counts both ends, with ids or resolved objects", () => {
  assert.deepEqual(buildDegreeMap([{ source: 1, target: 2 }, { source: { id: 2 }, target: { id: 3 } }]), { 1: 1, 2: 2, 3: 1 });
  assert.deepEqual(buildDegreeMap(undefined), {});
});

test("nodeRadius grows with sqrt of degree", () => {
  assert.equal(nodeRadius(0), 2);
  assert.equal(nodeRadius(undefined), 2);
  assert.equal(nodeRadius(4), 4);
});

test("fitTransform centres and scales the bounding box", () => {
  const t = fitTransform([{ x: 0, y: 0 }, { x: 100, y: 50 }], 400, 300, 50, 2);
  // box is 200 x 150 with padding, so k = min(400/200, 300/150, 2) = 2
  assert.equal(t.k, 2);
  assert.equal(t.x, 400 / 2 - 50 * 2);
  assert.equal(t.y, 300 / 2 - 25 * 2);
});

test("fitTransform returns null without positions or size", () => {
  assert.equal(fitTransform([{ x: null, y: null }], 400, 300), null);
  assert.equal(fitTransform([], 400, 300), null);
  assert.equal(fitTransform([{ x: 1, y: 1 }], 0, 300), null);
});

test("readOptions falls back to safe defaults", () => {
  assert.deepEqual(readOptions({ placement: "below", showLabels: "true" }), { placement: "below", showLabels: true });
  assert.deepEqual(readOptions({ placement: "sideways", showLabels: "yes" }), { placement: "replace", showLabels: false });
  assert.deepEqual(readOptions(undefined), { placement: "replace", showLabels: false });
});
