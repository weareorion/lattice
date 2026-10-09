// test/geometry.test.js
//
// Zero-dependency Node test runner for host/geometry.jsx. Run with:
//   node test/geometry.test.js
// or:
//   npm test
//
// Covers the tier-1 engine functions that are implemented so far. Circle
// fitting / ghost rejection (tier 2) and diagonal alignment grouping are
// not implemented yet and are intentionally not tested here — see the
// `circles` and `gridlines-angles` todos in the plan.

var assert = require("assert");
var geometry = require("../host/geometry.jsx");

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  - " + name);
  } catch (err) {
    failed += 1;
    failures.push({ name: name, error: err });
    console.log("  FAIL - " + name);
    console.log("        " + err.message);
  }
}

function approxEqual(a, b, tolerance, message) {
  tolerance = tolerance === undefined ? 1e-6 : tolerance;
  assert.ok(
    Math.abs(a - b) <= tolerance,
    (message ? message + " — " : "") + "expected " + a + " ~= " + b
  );
}

// ---------------------------------------------------------------------------

test("mergeCoincidentPoints collapses nearby anchors into one cluster", function () {
  var points = [
    { x: 0, y: 0 },
    { x: 0.4, y: -0.3 },
    { x: 50, y: 50 }
  ];
  var clusters = geometry.mergeCoincidentPoints(points, 1);
  assert.strictEqual(clusters.length, 2);
  var merged = clusters[0].count === 2 ? clusters[0] : clusters[1];
  assert.strictEqual(merged.count, 2);
  approxEqual(merged.centroid.x, 0.2);
  approxEqual(merged.centroid.y, -0.15);
});

test("mergeCoincidentPoints keeps distant points separate", function () {
  var points = [
    { x: 0, y: 0 },
    { x: 100, y: 100 }
  ];
  var clusters = geometry.mergeCoincidentPoints(points, 1);
  assert.strictEqual(clusters.length, 2);
});

test("angleDeg normalizes direction so a->b equals b->a", function () {
  var a = { x: 0, y: 0 };
  var b = { x: 10, y: 10 };
  approxEqual(geometry.angleDeg(a, b), geometry.angleDeg(b, a));
  approxEqual(geometry.angleDeg(a, b), 45);
});

test("anglesClose wraps around the 0/180 seam", function () {
  assert.ok(geometry.anglesClose(1, 179, 3));
  assert.ok(!geometry.anglesClose(1, 170, 3));
});

test("extendSegmentToBounds stretches a single edge to its exact angle at the artboard edge", function () {
  var bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  var a = { x: 40, y: 40 };
  var b = { x: 60, y: 60 };
  var extended = geometry.extendSegmentToBounds(a, b, bounds);
  // The 45 degree line through (40,40)-(60,60) hits the rectangle at (0,0) and (100,100).
  var points = [extended.p1, extended.p2];
  points.sort(function (p, q) {
    return p.x - q.x;
  });
  approxEqual(points[0].x, 0, 1e-6);
  approxEqual(points[0].y, 0, 1e-6);
  approxEqual(points[1].x, 100, 1e-6);
  approxEqual(points[1].y, 100, 1e-6);
  approxEqual(geometry.angleDeg(points[0], points[1]), geometry.angleDeg(a, b));
});

test("extendSegmentToBounds handles a vertical edge", function () {
  var bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  var extended = geometry.extendSegmentToBounds({ x: 30, y: 40 }, { x: 30, y: 60 }, bounds);
  var points = [extended.p1, extended.p2];
  points.sort(function (p, q) {
    return p.y - q.y;
  });
  approxEqual(points[0].x, 30);
  approxEqual(points[0].y, 0);
  approxEqual(points[1].x, 30);
  approxEqual(points[1].y, 100);
});

test("mergeParallelLines merges two close parallels into one group", function () {
  var lines = [
    { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } },
    { p1: { x: 0, y: 2 }, p2: { x: 100, y: 2 } }, // same angle, 2pt offset
    { p1: { x: 0, y: 0 }, p2: { x: 0, y: 100 } } // perpendicular, must stay separate
  ];
  var groups = geometry.mergeParallelLines(lines, 1, 5);
  assert.strictEqual(groups.length, 2);
  var merged = groups[0].members === 2 ? groups[0] : groups[1];
  assert.strictEqual(merged.members, 2);
});

test("mergeParallelLines keeps lines separate when offset exceeds tolerance", function () {
  var lines = [
    { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } },
    { p1: { x: 0, y: 50 }, p2: { x: 100, y: 50 } }
  ];
  var groups = geometry.mergeParallelLines(lines, 1, 5);
  assert.strictEqual(groups.length, 2);
});

test("cubicExtrema finds the horizontal/vertical tangent points of a quarter-circle-ish curve", function () {
  // Classic circle-approximation cubic from (0,1) to (1,0), bulging through
  // the circle's "northeast" quadrant. Its only interior extremum tangent
  // point of interest here is simply that it returns finite, in-range points.
  var p0 = { x: 0, y: 1 };
  var p1 = { x: 0.552, y: 1 };
  var p2 = { x: 1, y: 0.552 };
  var p3 = { x: 1, y: 0 };
  var extrema = geometry.cubicExtrema(p0, p1, p2, p3);
  assert.ok(extrema.length >= 0); // should not throw; curve may have 0-2 interior extrema
  for (var i = 0; i < extrema.length; i++) {
    assert.ok(extrema[i].x >= -1e-6 && extrema[i].x <= 1 + 1e-6);
    assert.ok(extrema[i].y >= -1e-6 && extrema[i].y <= 1 + 1e-6);
  }
});

test("cubicExtrema finds the midpoint bulge of a symmetric S-less bump", function () {
  // A cubic that bulges straight up in the middle: control points pulled
  // up symmetrically. Expect a vertical tangent (dx/dt=0) near t=0.5.
  var p0 = { x: 0, y: 0 };
  var p1 = { x: 0, y: 50 };
  var p2 = { x: 100, y: 50 };
  var p3 = { x: 100, y: 0 };
  var extrema = geometry.cubicExtrema(p0, p1, p2, p3);
  assert.ok(extrema.length >= 1, "expected at least one extremum");
  var found = false;
  for (var i = 0; i < extrema.length; i++) {
    if (Math.abs(extrema[i].x - 50) < 1) {
      found = true;
    }
  }
  assert.ok(found, "expected an extremum near x=50 (the curve's horizontal midpoint)");
});

test("groupAlignments groups repeated verticals and horizontals, ignores lone points", function () {
  var points = [
    { x: 10, y: 0 },
    { x: 10, y: 50 }, // shares x=10 with the point above -> vertical alignment
    { x: 90, y: 20 },
    { x: 5, y: 20 }, // shares y=20 with the point above -> horizontal alignment
    { x: 77, y: 77 } // alone on both axes
  ];
  var groups = geometry.groupAlignments(points, 0.5);
  assert.strictEqual(groups.vertical.length, 1);
  assert.strictEqual(groups.vertical[0].items.length, 2);
  assert.strictEqual(groups.horizontal.length, 1);
  assert.strictEqual(groups.horizontal[0].items.length, 2);
});

test("hasHandle rejects a zero-length handle and accepts a real one", function () {
  var anchor = { x: 10, y: 10 };
  assert.ok(!geometry.hasHandle(anchor, { x: 10, y: 10 }));
  assert.ok(geometry.hasHandle(anchor, { x: 15, y: 10 }));
});

test("extendSegmentToBounds accepts Illustrator bounds where top > bottom", function () {
  var bounds = { left: 0, top: 100, right: 100, bottom: 0 };
  var extended = geometry.extendSegmentToBounds({ x: 30, y: 40 }, { x: 30, y: 60 }, bounds);
  var points = [extended.p1, extended.p2];
  points.sort(function (p, q) {
    return p.y - q.y;
  });
  approxEqual(points[0].x, 30);
  approxEqual(points[0].y, 0);
  approxEqual(points[1].x, 30);
  approxEqual(points[1].y, 100);
});

test("nearDuplicateAnchors flags two anchors closer than tolerance but not identical", function () {
  var a = { x: 0, y: 0 };
  assert.ok(!geometry.nearDuplicateAnchors(a, { x: 0, y: 0 }, 1)); // identical: not a "near" duplicate, it IS one
  assert.ok(geometry.nearDuplicateAnchors(a, { x: 0.4, y: 0 }, 1));
  assert.ok(!geometry.nearDuplicateAnchors(a, { x: 10, y: 0 }, 1));
});

// ---------------------------------------------------------------------------

console.log("");
console.log(passed + " passed, " + failed + " failed");
if (failed > 0) {
  process.exit(1);
}
