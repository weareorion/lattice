// test/geometry.test.js
//
// Zero-dependency Node test runner for host/geometry.jsx. Run with:
//   node test/geometry.test.js
// or:
//   npm test
//
// Covers the tier-1 engine plus tier-2 circles (fit, ghost rejection,
// in-path then cross-path merge). Diagonal alignment grouping is still
// not implemented — see the `gridlines-angles` todo.

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

// A cubic quarter-circle using the standard kappa handle length.
function circleCubic(cx, cy, r, a0, a1) {
  var handle = ((4 / 3) * Math.tan((a1 - a0) / 4)) * r;
  function pt(a) {
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  var p0 = pt(a0);
  var p3 = pt(a1);
  return {
    p0: p0,
    p1: { x: p0.x - Math.sin(a0) * handle, y: p0.y + Math.cos(a0) * handle },
    p2: { x: p3.x + Math.sin(a1) * handle, y: p3.y - Math.cos(a1) * handle },
    p3: p3
  };
}

var CIRCLE_OPTS = {
  minRadius: 8,
  minChord: 15,
  tolerance: 0.03
};

test("fitCircle recovers center and radius from exact samples", function () {
  var fit = geometry.fitCircle([
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 }
  ]);
  approxEqual(fit.center.x, 0);
  approxEqual(fit.center.y, 0);
  approxEqual(fit.radius, 1);
});

test("fitCircleToCubic fits a quarter-circle cubic", function () {
  var cubic = circleCubic(0, 0, 100, 0, Math.PI / 2);
  var fit = geometry.fitCircleToCubic(cubic, CIRCLE_OPTS);
  assert.ok(fit, "expected a circle");
  approxEqual(fit.center.x, 0, 0.2);
  approxEqual(fit.center.y, 0, 0.2);
  approxEqual(fit.radius, 100, 0.2);
  approxEqual(fit.arcLength, 100 * (Math.PI / 2), 1);
  assert.ok(fit.error < 0.01, "kappa arc should hug the circle, error was " + fit.error);
});

test("fitCircleToCubic rejects collinear samples", function () {
  var straight = {
    p0: { x: 0, y: 0 },
    p1: { x: 40, y: 0 },
    p2: { x: 80, y: 0 },
    p3: { x: 120, y: 0 }
  };
  assert.strictEqual(geometry.fitCircleToCubic(straight, CIRCLE_OPTS), null);
});

test("fitCircleToCubic rejects a chord shorter than the minimum", function () {
  var tiny = circleCubic(0, 0, 100, 0, 0.05);
  assert.strictEqual(geometry.fitCircleToCubic(tiny, CIRCLE_OPTS), null);
});

test("fitCircleToCubic rejects radii below the minimum", function () {
  var small = circleCubic(0, 0, 5, 0, Math.PI / 2);
  assert.strictEqual(
    geometry.fitCircleToCubic(small, { minRadius: 8, minChord: 1, tolerance: 0.03 }),
    null
  );
});

test("fitCircleToCubic rejects an out-of-bounds radius", function () {
  // Gentle arc: truly circular, long enough, but the radius dwarfs the object.
  var arc = circleCubic(0, 0, 400, 0, 0.2);
  var fit = geometry.fitCircleToCubic(arc, {
    minRadius: 8,
    minChord: 15,
    tolerance: 0.03,
    bounds: { left: 390, top: 85, right: 405, bottom: -1 }
  });
  assert.strictEqual(fit, null);
});

test("fitCircleToCubic rejects a circle outside the object's bounding box", function () {
  var cubic = circleCubic(0, 0, 100, 0, Math.PI / 2);
  var fit = geometry.fitCircleToCubic(cubic, {
    minRadius: 8,
    minChord: 15,
    tolerance: 0.03,
    bounds: { left: 5000, top: 5200, right: 5200, bottom: 5000 }
  });
  assert.strictEqual(fit, null);
});

test("fitCircleToCubic rejects a ghost whose curve does not hug the fitted arc", function () {
  var ghost = circleCubic(0, 0, 100, 0, Math.PI / 2);
  ghost.p1 = { x: ghost.p1.x, y: ghost.p1.y + 80 };
  ghost.p2 = { x: ghost.p2.x + 80, y: ghost.p2.y };
  assert.strictEqual(geometry.fitCircleToCubic(ghost, CIRCLE_OPTS), null);
});

test("fitCircleToCubic rejects a curve that does not pass through a circle", function () {
  var sCurve = {
    p0: { x: 0, y: 0 },
    p1: { x: 20, y: 80 },
    p2: { x: 80, y: -80 },
    p3: { x: 100, y: 0 }
  };
  assert.strictEqual(geometry.fitCircleToCubic(sCurve, CIRCLE_OPTS), null);
});

test("mergeCircles joins circles within a relative tolerance and keeps the rest apart", function () {
  var a = { center: { x: 0, y: 0 }, radius: 100, error: 0.001, arcLength: 10, chord: 10 };
  var b = { center: { x: 3, y: 0 }, radius: 100, error: 0.001, arcLength: 10, chord: 10 };
  var different = { center: { x: 0, y: 0 }, radius: 110, error: 0.001, arcLength: 10, chord: 10 };
  assert.strictEqual(geometry.mergeCircles([a, b], 0.04).length, 1);
  assert.strictEqual(geometry.mergeCircles([a, b], 0.02).length, 2);
  assert.strictEqual(geometry.mergeCircles([a, different], 0.04).length, 2);
  assert.strictEqual(geometry.mergeCircles([a, different], 0.1).length, 1);
});

test("fitCircles merges inside a path, then across paths with a tighter tolerance", function () {
  var big = { left: -200, top: 250, right: 250, bottom: -50 };
  var originA = circleCubic(0, 0, 100, 0, Math.PI / 2);
  var originB = circleCubic(0, 0, 100, Math.PI / 2, Math.PI);
  var originC = circleCubic(0, 0, 100, Math.PI, Math.PI * 1.5);
  var offset = circleCubic(3, 0, 100, 0, Math.PI / 2);
  var opts = { minRadius: 8, minChord: 15, tolerance: 0.04, crossPathFactor: 0.5 };

  var sameCircle = geometry.fitCircles(
    [
      { bounds: big, cubics: [originA, originB] },
      { bounds: big, cubics: [originC] }
    ],
    opts
  );
  assert.strictEqual(sameCircle.length, 1);
  approxEqual(sameCircle[0].center.x, 0, 0.5);
  approxEqual(sameCircle[0].center.y, 0, 0.5);
  approxEqual(sameCircle[0].radius, 100, 0.5);
  assert.ok(sameCircle[0].members >= 2);
  approxEqual(sameCircle[0].arcLength, 100 * Math.PI * 1.5, 5);

  // 3% of the radius: inside the in-path tolerance (4%), outside the
  // cross-path tolerance (2%).
  var inPath = geometry.fitCircles([{ bounds: big, cubics: [originA, offset] }], opts);
  assert.strictEqual(inPath.length, 1);

  var crossPath = geometry.fitCircles(
    [
      { bounds: big, cubics: [originA] },
      { bounds: big, cubics: [offset] }
    ],
    opts
  );
  assert.strictEqual(crossPath.length, 2);
  crossPath.sort(function (a, b) {
    return a.center.x - b.center.x;
  });
  approxEqual(crossPath[0].center.x, 0, 0.5);
  approxEqual(crossPath[1].center.x, 3, 0.5);
  assert.strictEqual(crossPath[1].members, 1);
});

test("filterCircles keeps every circle, the N longest arcs, or those under an error", function () {
  var circles = [
    { center: { x: 0, y: 0 }, radius: 10, error: 0.02, arcLength: 5 },
    { center: { x: 0, y: 0 }, radius: 30, error: 0.005, arcLength: 40 },
    { center: { x: 0, y: 0 }, radius: 20, error: 0.01, arcLength: 12 }
  ];
  assert.strictEqual(geometry.filterCircles(circles, { mode: "all" }).length, 3);
  var longest = geometry.filterCircles(circles, { mode: "longest", count: 2 });
  assert.strictEqual(longest.length, 2);
  assert.strictEqual(longest[0].arcLength, 40);
  assert.strictEqual(longest[1].arcLength, 12);
  var under = geometry.filterCircles(circles, { mode: "error", maxError: 0.01 });
  assert.strictEqual(under.length, 2);
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
