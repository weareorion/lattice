// host/geometry.jsx
//
// Pure, DOM-free geometry helpers shared between Node (unit tests) and
// ExtendScript (host/main.jsx, loaded via #include). No Illustrator API
// calls happen in this file — that's the whole point: it must run
// unmodified under plain Node for the test suite.
//
// Written in ES3 on purpose: no let/const, no arrow functions, no
// template literals, no array extras (map/filter/forEach) assumed to
// exist, since ExtendScript's JS engine does not reliably provide them.

var Lattice = Lattice || {};

Lattice.geometry = (function () {
  var api = {};

  // ---- basics ---------------------------------------------------------

  function distance(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  api.distance = distance;

  // Point-to-infinite-line distance (line defined by two points a, b).
  function pointToLineDistance(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) {
      return distance(p, a);
    }
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  }
  api.pointToLineDistance = pointToLineDistance;

  // ---- coincident point merging ---------------------------------------

  // Greedy single-link clustering: fine for the anchor counts a logo path
  // has (tens, not millions). Returns an array of clusters:
  // { centroid: {x,y}, points: [...], count: N }
  function mergeCoincidentPoints(points, tolerance) {
    var clusters = [];
    var i, j, p, c, found, sumX, sumY, k;

    for (i = 0; i < points.length; i++) {
      p = points[i];
      found = null;
      for (j = 0; j < clusters.length; j++) {
        c = clusters[j];
        if (distance(p, c.centroid) <= tolerance) {
          found = c;
          break;
        }
      }
      if (found) {
        found.points.push(p);
        sumX = 0;
        sumY = 0;
        for (k = 0; k < found.points.length; k++) {
          sumX += found.points[k].x;
          sumY += found.points[k].y;
        }
        found.centroid = { x: sumX / found.points.length, y: sumY / found.points.length };
        found.count = found.points.length;
      } else {
        clusters.push({ centroid: { x: p.x, y: p.y }, points: [p], count: 1 });
      }
    }
    return clusters;
  }
  api.mergeCoincidentPoints = mergeCoincidentPoints;

  // ---- angles -----------------------------------------------------------

  // A line's angle is direction-agnostic: a->b and b->a describe the same
  // line, so we normalize into [0, 180).
  function angleDeg(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    deg = deg % 180;
    if (deg < 0) {
      deg += 180;
    }
    return deg;
  }
  api.angleDeg = angleDeg;

  // Compares two [0,180) angles, accounting for wraparound at the 0/180 seam.
  function anglesClose(a1, a2, toleranceDeg) {
    var diff = Math.abs(a1 - a2);
    diff = Math.min(diff, 180 - diff);
    return diff <= toleranceDeg;
  }
  api.anglesClose = anglesClose;

  // ---- edge extension -----------------------------------------------------

  // Extends the infinite line through a,b until it exits the rectangle
  // described by bounds = {left, top, right, bottom}. Returns
  // { p1: {x,y}, p2: {x,y} } — the two points where the line crosses the
  // rectangle's boundary, i.e. the drawn "extended edge" segment.
  //
  // Falls back to the original a,b segment if the line is degenerate
  // (a === b) or doesn't actually cross the rectangle (shouldn't happen
  // when bounds is the artboard/selection the segment came from, but we
  // don't want to throw on bad input).
  function extendSegmentToBounds(a, b, bounds) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var eps = 1e-6;
    var candidates = [];
    var tLeft, tRight, tTop, tBottom, i, c, valid;

    if (dx !== 0) {
      tLeft = (bounds.left - a.x) / dx;
      candidates.push({ t: tLeft, x: bounds.left, y: a.y + tLeft * dy });
      tRight = (bounds.right - a.x) / dx;
      candidates.push({ t: tRight, x: bounds.right, y: a.y + tRight * dy });
    }
    if (dy !== 0) {
      tTop = (bounds.top - a.y) / dy;
      candidates.push({ t: tTop, x: a.x + tTop * dx, y: bounds.top });
      tBottom = (bounds.bottom - a.y) / dy;
      candidates.push({ t: tBottom, x: a.x + tBottom * dx, y: bounds.bottom });
    }

    // Accept either y-up bounds (Illustrator: top > bottom) or y-down
    // bounds (tests historically used top < bottom). The rectangle is the
    // same; only the validity window needs both orders.
    var xMin = Math.min(bounds.left, bounds.right) - eps;
    var xMax = Math.max(bounds.left, bounds.right) + eps;
    var yMin = Math.min(bounds.top, bounds.bottom) - eps;
    var yMax = Math.max(bounds.top, bounds.bottom) + eps;

    valid = [];
    for (i = 0; i < candidates.length; i++) {
      c = candidates[i];
      if (c.x >= xMin && c.x <= xMax && c.y >= yMin && c.y <= yMax) {
        valid.push(c);
      }
    }

    if (valid.length < 2) {
      return { p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y } };
    }

    valid.sort(function (m, n) {
      return m.t - n.t;
    });
    return {
      p1: { x: valid[0].x, y: valid[0].y },
      p2: { x: valid[valid.length - 1].x, y: valid[valid.length - 1].y }
    };
  }
  api.extendSegmentToBounds = extendSegmentToBounds;

  // ---- parallel merge -----------------------------------------------------

  // Groups lines ({p1,p2}) whose angle and perpendicular offset both fall
  // under the given tolerances. Returns an array of groups:
  // { line: {p1,p2}, members: N } where `line` is the first member seen
  // (callers extend it to bounds afterwards, so the exact representative
  // doesn't matter — only that duplicates collapse to one).
  function mergeParallelLines(lines, angleToleranceDeg, distanceTolerance) {
    var groups = [];
    var i, j, line, angle, g, matched;

    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      angle = angleDeg(line.p1, line.p2);
      matched = null;
      for (j = 0; j < groups.length; j++) {
        g = groups[j];
        if (
          anglesClose(angle, g.angle, angleToleranceDeg) &&
          pointToLineDistance(line.p1, g.line.p1, g.line.p2) <= distanceTolerance
        ) {
          matched = g;
          break;
        }
      }
      if (matched) {
        matched.members += 1;
      } else {
        groups.push({ line: line, angle: angle, members: 1 });
      }
    }

    return groups;
  }
  api.mergeParallelLines = mergeParallelLines;

  // ---- cubic bezier extrema -----------------------------------------------

  function solveQuadratic(a, b, c) {
    var roots = [];
    var eps = 1e-9;
    var disc, sq;

    if (Math.abs(a) < eps) {
      if (Math.abs(b) < eps) {
        return roots;
      }
      roots.push(-c / b);
      return roots;
    }
    disc = b * b - 4 * a * c;
    if (disc < 0) {
      return roots;
    }
    sq = Math.sqrt(disc);
    roots.push((-b + sq) / (2 * a));
    roots.push((-b - sq) / (2 * a));
    return roots;
  }
  api.solveQuadratic = solveQuadratic;

  function evalCubic(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    var a = mt * mt * mt;
    var b = 3 * mt * mt * t;
    var c = 3 * mt * t * t;
    var d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }
  api.evalCubic = evalCubic;

  // Returns the points on a cubic bezier (p0..p3 control points) where the
  // tangent is horizontal or vertical, excluding the endpoints themselves.
  // These feed the "alignments" layer alongside real anchors.
  function cubicExtrema(p0, p1, p2, p3) {
    var points = [];
    var axes = ["x", "y"];
    var axisIndex, axis, c0, c1, c2, a, b, c, roots, i, t;

    for (axisIndex = 0; axisIndex < axes.length; axisIndex++) {
      axis = axes[axisIndex];
      c0 = p1[axis] - p0[axis];
      c1 = p2[axis] - p1[axis];
      c2 = p3[axis] - p2[axis];
      a = c0 - 2 * c1 + c2;
      b = 2 * (c1 - c0);
      c = c0;
      roots = solveQuadratic(a, b, c);
      for (i = 0; i < roots.length; i++) {
        t = roots[i];
        if (t > 1e-6 && t < 1 - 1e-6) {
          points.push(evalCubic(p0, p1, p2, p3, t));
        }
      }
    }
    return points;
  }
  api.cubicExtrema = cubicExtrema;

  // ---- alignment grouping (axis-aligned; tier 1) --------------------------

  // Clusters points that share an x (vertical alignment) or y (horizontal
  // alignment) coordinate within `tolerance`. Only clusters with 2+ points
  // are returned — a single stray coordinate isn't a "repeated" alignment.
  //
  // Diagonal alignment grouping (high-sensitivity mode) is tier-1 scope but
  // not implemented yet — tracked as follow-up work on the
  // `gridlines-angles` todo; it needs pairwise collinearity grouping rather
  // than this simple 1D clustering.
  function cluster1D(values, pointsRef, tolerance) {
    var groups = [];
    var i, v, found, g, sum, k;

    for (i = 0; i < values.length; i++) {
      v = values[i];
      found = null;
      for (g = 0; g < groups.length; g++) {
        if (Math.abs(groups[g].value - v) <= tolerance) {
          found = groups[g];
          break;
        }
      }
      if (found) {
        found.values.push(v);
        found.items.push(pointsRef[i]);
        sum = 0;
        for (k = 0; k < found.values.length; k++) {
          sum += found.values[k];
        }
        found.value = sum / found.values.length;
      } else {
        groups.push({ value: v, values: [v], items: [pointsRef[i]] });
      }
    }
    return groups;
  }

  function onlyRepeated(groups) {
    var out = [];
    var i;
    for (i = 0; i < groups.length; i++) {
      if (groups[i].items.length >= 2) {
        out.push({ value: groups[i].value, items: groups[i].items });
      }
    }
    return out;
  }

  function groupAlignments(points, tolerance) {
    var xs = [];
    var ys = [];
    var i;
    for (i = 0; i < points.length; i++) {
      xs.push(points[i].x);
      ys.push(points[i].y);
    }
    var vertical = cluster1D(xs, points, tolerance);
    var horizontal = cluster1D(ys, points, tolerance);
    return {
      vertical: onlyRepeated(vertical),
      horizontal: onlyRepeated(horizontal)
    };
  }
  api.groupAlignments = groupAlignments;

  // ---- handles -------------------------------------------------------------

  // Illustrator sets leftDirection/rightDirection equal to the anchor when
  // there's effectively no handle. Only draw a handle when it has length.
  function hasHandle(anchor, handlePoint, epsilon) {
    return distance(anchor, handlePoint) > (epsilon || 1e-6);
  }
  api.hasHandle = hasHandle;

  // ---- audit (tier 3 groundwork) --------------------------------------------

  // Two anchors are a likely accident (not an intentional coincident point)
  // when they're closer than `tolerance` but not exactly equal.
  function nearDuplicateAnchors(a, b, tolerance) {
    var d = distance(a, b);
    return d > 0 && d <= tolerance;
  }
  api.nearDuplicateAnchors = nearDuplicateAnchors;

  return api;
})();

// Node (tests) sees `module`; ExtendScript does not, so this is a no-op
// there and `Lattice.geometry` is simply left as a global for #include.
if (typeof module !== "undefined" && module.exports) {
  module.exports = Lattice.geometry;
}
