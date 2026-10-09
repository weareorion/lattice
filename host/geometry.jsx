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

  // ---- circles (tier 2) -------------------------------------------------------
  //
  // For each cubic long enough to be a real arc, sample the curve, fit a
  // circle, and reject anything that is not actually that circle: collinear
  // samples, radii outside the caller's range or the object's bounds, fits
  // that miss the samples, and ghosts whose bezier wanders off the arc
  // between the fit samples. Merging is two-pass — looser inside one path,
  // tighter across paths — so a broken ellipse becomes one circle without
  // gluing neighboring marks together.

  var PHI = (1 + Math.sqrt(5)) / 2;
  var MAX_BACKGROUND_LINES = 600;
  var MAX_BACKGROUND_POLYGONS = 800;

  function sampleCubic(p0, p1, p2, p3, segments) {
    var pts = [];
    var n = segments < 1 ? 1 : segments;
    var i;
    for (i = 0; i <= n; i++) {
      pts.push(evalCubic(p0, p1, p2, p3, i / n));
    }
    return pts;
  }
  api.sampleCubic = sampleCubic;

  function maxLineDeviation(points) {
    var a = points[0];
    var b = points[points.length - 1];
    var maxDev = 0;
    var i;
    var d;
    for (i = 1; i < points.length - 1; i++) {
      d = pointToLineDistance(points[i], a, b);
      if (d > maxDev) {
        maxDev = d;
      }
    }
    return maxDev;
  }

  // Algebraic circle fit (modified least squares) on an arbitrary point
  // list. Returns null when the points are collinear or too few to define
  // a circle — the determinant of the normal equations collapses.
  function fitCircle(points) {
    var n = points.length;
    var meanX = 0;
    var meanY = 0;
    var i;
    var u;
    var v;
    var Suu = 0;
    var Suv = 0;
    var Svv = 0;
    var Suuu = 0;
    var Suvv = 0;
    var Svvv = 0;
    var Svuu = 0;
    var det;
    var uc;
    var vc;
    var radius;

    if (n < 3) {
      return null;
    }
    for (i = 0; i < n; i++) {
      meanX += points[i].x;
      meanY += points[i].y;
    }
    meanX /= n;
    meanY /= n;

    for (i = 0; i < n; i++) {
      u = points[i].x - meanX;
      v = points[i].y - meanY;
      Suu += u * u;
      Svv += v * v;
      Suv += u * v;
      Suuu += u * u * u;
      Svvv += v * v * v;
      Suvv += u * v * v;
      Svuu += v * u * u;
    }

    det = Suu * Svv - Suv * Suv;
    if (Math.abs(det) < 1e-12 * (Suu + Svv) * (Suu + Svv) + 1e-18) {
      return null;
    }
    uc = (0.5 * (Suuu + Suvv) * Svv - Suv * 0.5 * (Svvv + Svuu)) / det;
    vc = (Suu * 0.5 * (Svvv + Svuu) - 0.5 * (Suuu + Suvv) * Suv) / det;
    radius = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);
    if (!(radius > 0) || radius !== radius) {
      return null;
    }
    return {
      center: { x: uc + meanX, y: vc + meanY },
      radius: radius
    };
  }
  api.fitCircle = fitCircle;

  function boundsDiagonal(bounds) {
    var w = Math.abs(bounds.right - bounds.left);
    var h = Math.abs(bounds.bottom - bounds.top);
    return Math.sqrt(w * w + h * h);
  }

  function circleIntersectsBounds(center, radius, bounds) {
    var xMin = Math.min(bounds.left, bounds.right);
    var xMax = Math.max(bounds.left, bounds.right);
    var yMin = Math.min(bounds.top, bounds.bottom);
    var yMax = Math.max(bounds.top, bounds.bottom);
    var cx = center.x;
    var cy = center.y;
    if (cx < xMin) {
      cx = xMin;
    } else if (cx > xMax) {
      cx = xMax;
    }
    if (cy < yMin) {
      cy = yMin;
    } else if (cy > yMax) {
      cy = yMax;
    }
    return distance(center, { x: cx, y: cy }) <= radius + 1e-6;
  }

  // Sweep of the arc p0 → pmid → p3 as seen from center, in radians.
  // The midpoint picks which way around the circle the bezier actually went,
  // so a quarter-turn is not reported as the long way around.
  function sweepAngle(center, p0, pmid, p3) {
    function ang(p) {
      return Math.atan2(p.y - center.y, p.x - center.x);
    }
    function ccw(from, to) {
      var d = to - from;
      while (d < 0) {
        d += 2 * Math.PI;
      }
      while (d >= 2 * Math.PI) {
        d -= 2 * Math.PI;
      }
      return d;
    }
    var a0 = ang(p0);
    var am = ang(pmid);
    var a3 = ang(p3);
    var full = ccw(a0, a3);
    if (ccw(a0, am) <= full) {
      return full;
    }
    return 2 * Math.PI - full;
  }

  function fitCircleToCubic(cubic, options) {
    var minRadius;
    var minChord;
    var tolerance;
    var collinearEpsilon;
    var maxRadiusFactor;
    var chord;
    var fitSamples;
    var fit;
    var radius;
    var center;
    var diag;
    var dense;
    var maxAbs;
    var i;
    var err;
    var error;
    var mid;
    var sweep;

    options = options || {};
    minRadius = options.minRadius !== undefined ? options.minRadius : 8;
    minChord = options.minChord !== undefined ? options.minChord : 15;
    tolerance = options.tolerance !== undefined ? options.tolerance : 0.03;
    collinearEpsilon = options.collinearEpsilon !== undefined ? options.collinearEpsilon : 0.25;
    maxRadiusFactor = options.maxRadiusFactor !== undefined ? options.maxRadiusFactor : 4;

    chord = distance(cubic.p0, cubic.p3);
    if (!(chord >= minChord)) {
      return null;
    }

    fitSamples = sampleCubic(cubic.p0, cubic.p1, cubic.p2, cubic.p3, 4);
    if (maxLineDeviation(fitSamples) <= collinearEpsilon) {
      return null;
    }

    fit = fitCircle(fitSamples);
    if (!fit) {
      return null;
    }
    radius = fit.radius;
    center = fit.center;
    if (!(radius >= minRadius) || radius > 1e6) {
      return null;
    }

    if (options.bounds) {
      diag = boundsDiagonal(options.bounds);
      if (diag > 1 && radius > diag * maxRadiusFactor) {
        return null;
      }
      if (diag > 1 && !circleIntersectsBounds(center, radius, options.bounds)) {
        return null;
      }
    }

    // Dense samples cover the fit knots (16 is a multiple of 4) and the
    // spans between them. A ghost can thread the knots and still leave the arc.
    dense = sampleCubic(cubic.p0, cubic.p1, cubic.p2, cubic.p3, 16);
    maxAbs = 0;
    for (i = 0; i < dense.length; i++) {
      err = Math.abs(distance(dense[i], center) - radius);
      if (err > maxAbs) {
        maxAbs = err;
      }
    }
    error = maxAbs / radius;
    if (error > tolerance) {
      return null;
    }

    mid = evalCubic(cubic.p0, cubic.p1, cubic.p2, cubic.p3, 0.5);
    sweep = sweepAngle(center, cubic.p0, mid, cubic.p3);
    return {
      center: { x: center.x, y: center.y },
      radius: radius,
      error: error,
      arcLength: radius * sweep,
      chord: chord
    };
  }
  api.fitCircleToCubic = fitCircleToCubic;

  // relTolerance is a fraction of the larger radius: 0.03 means centers and
  // radii must agree within 3%. Greedy, same shape as the other mergers —
  // logo arc counts stay in the dozens.
  function mergeCircles(circles, relTolerance) {
    var groups = [];
    var i;
    var j;
    var c;
    var g;
    var matched;
    var rMax;
    var w;
    var W;

    for (i = 0; i < circles.length; i++) {
      c = circles[i];
      matched = null;
      for (j = 0; j < groups.length; j++) {
        g = groups[j];
        rMax = g.radius > c.radius ? g.radius : c.radius;
        if (!(rMax > 0)) {
          continue;
        }
        if (
          Math.abs(g.radius - c.radius) <= relTolerance * rMax &&
          distance(g.center, c.center) <= relTolerance * rMax
        ) {
          matched = g;
          break;
        }
      }
      if (matched) {
        w = c.arcLength > 0 ? c.arcLength : 1;
        W = matched.weight;
        matched.center = {
          x: (matched.center.x * W + c.center.x * w) / (W + w),
          y: (matched.center.y * W + c.center.y * w) / (W + w)
        };
        matched.radius = (matched.radius * W + c.radius * w) / (W + w);
        if (c.error > matched.error) {
          matched.error = c.error;
        }
        matched.arcLength += c.arcLength > 0 ? c.arcLength : 0;
        if ((c.chord || 0) > matched.chord) {
          matched.chord = c.chord;
        }
        matched.weight = W + w;
        matched.members += 1;
      } else {
        w = c.arcLength > 0 ? c.arcLength : 1;
        groups.push({
          center: { x: c.center.x, y: c.center.y },
          radius: c.radius,
          error: c.error || 0,
          arcLength: c.arcLength > 0 ? c.arcLength : 0,
          chord: c.chord || 0,
          weight: w,
          members: 1
        });
      }
    }
    return groups;
  }
  api.mergeCircles = mergeCircles;

  // paths: [{ bounds: {left,top,right,bottom}, cubics: [{p0,p1,p2,p3}] }]
  // In-path merge uses `tolerance`. The cross-path pass multiplies it by
  // `crossPathFactor` (default 0.5) so identical arcs on separate paths
  // still join, while near-misses that would merge inside one path do not.
  function fitCircles(paths, options) {
    var tolerance;
    var cross;
    var perPath = [];
    var p;
    var i;
    var fitted;
    var cubics;
    var fitOpts;
    var found;
    var merged;

    options = options || {};
    tolerance = options.tolerance !== undefined ? options.tolerance : 0.03;
    cross = options.crossPathFactor !== undefined ? options.crossPathFactor : 0.5;

    for (p = 0; p < paths.length; p++) {
      fitted = [];
      cubics = paths[p].cubics || [];
      fitOpts = {
        minRadius: options.minRadius,
        minChord: options.minChord,
        tolerance: tolerance,
        maxRadiusFactor: options.maxRadiusFactor,
        collinearEpsilon: options.collinearEpsilon,
        bounds: paths[p].bounds
      };
      for (i = 0; i < cubics.length; i++) {
        found = fitCircleToCubic(cubics[i], fitOpts);
        if (found) {
          fitted.push(found);
        }
      }
      merged = mergeCircles(fitted, tolerance);
      for (i = 0; i < merged.length; i++) {
        perPath.push(merged[i]);
      }
    }
    return mergeCircles(perPath, tolerance * cross);
  }
  api.fitCircles = fitCircles;

  // display.mode: "all" | "longest" | "error"
  // longest keeps the `count` arcs with the greatest arc length.
  // error keeps circles whose max radial error is <= maxError (a fraction).
  function filterCircles(circles, display) {
    var mode;
    var out = [];
    var copy;
    var i;
    var n;

    display = display || {};
    mode = display.mode || "all";
    if (mode === "error") {
      for (i = 0; i < circles.length; i++) {
        if (circles[i].error <= display.maxError) {
          out.push(circles[i]);
        }
      }
      return out;
    }
    if (mode === "longest") {
      copy = circles.slice(0);
      copy.sort(function (a, b) {
        if (a.arcLength === b.arcLength) {
          return a.error - b.error;
        }
        return b.arcLength - a.arcLength;
      });
      n = display.count;
      if (!(n >= 0)) {
        n = copy.length;
      }
      if (n > copy.length) {
        n = copy.length;
      }
      for (i = 0; i < n; i++) {
        out.push(copy[i]);
      }
      return out;
    }
    for (i = 0; i < circles.length; i++) {
      out.push(circles[i]);
    }
    return out;
  }
  api.filterCircles = filterCircles;

  // ---- module + background grid (tier 2) ------------------------------------

  function uniqueSorted(values, tolerance) {
    var sorted = values.slice(0);
    var out = [];
    var i;
    sorted.sort(function (a, b) {
      return a - b;
    });
    for (i = 0; i < sorted.length; i++) {
      if (out.length === 0 || Math.abs(sorted[i] - out[out.length - 1]) > tolerance) {
        out.push(sorted[i]);
      }
    }
    return out;
  }

  function approxGcd(a, b, tol) {
    var rem;
    var guard = 0;
    var swap;
    a = Math.abs(a);
    b = Math.abs(b);
    if (a < b) {
      swap = a;
      a = b;
      b = swap;
    }
    while (b > tol && guard < 32) {
      rem = a % b;
      if (rem > b - tol) {
        rem = 0;
      }
      a = b;
      b = rem;
      guard += 1;
    }
    return a;
  }

  // Largest spacing that tiles the sorted positions, within `tolerance`.
  // Returns null when there is nothing repeated to measure.
  function estimateModule(positions, tolerance) {
    var uniq;
    var gaps = [];
    var i;
    var gap;
    var m;
    if (!positions || positions.length < 2) {
      return null;
    }
    uniq = uniqueSorted(positions, tolerance);
    if (uniq.length < 2) {
      return null;
    }
    for (i = 1; i < uniq.length; i++) {
      gap = uniq[i] - uniq[i - 1];
      if (gap > tolerance) {
        gaps.push(gap);
      }
    }
    if (gaps.length === 0) {
      return null;
    }
    m = gaps[0];
    for (i = 1; i < gaps.length; i++) {
      m = approxGcd(m, gaps[i], tolerance);
    }
    if (!(m > tolerance)) {
      return null;
    }
    return m;
  }
  api.estimateModule = estimateModule;

  function fallbackModule(bounds) {
    var w = 0;
    var h = 0;
    var side;
    var m;
    if (bounds) {
      w = Math.abs(bounds.right - bounds.left);
      h = Math.abs(bounds.top - bounds.bottom);
    }
    side = w < h ? w : h;
    if (!(side > 0)) {
      side = w > h ? w : h;
    }
    if (!(side > 0)) {
      return 16;
    }
    m = side / 8;
    if (m < 2) {
      m = 2;
    }
    return m;
  }

  // xs / ys are alignment coordinates (repeated construction lines), not
  // every anchor — stray curve points would collapse the divisor. When the
  // mark has no repeated spacing, fall back to an eighth of the short side.
  function measureModule(xs, ys, bounds, tolerance) {
    var mx = estimateModule(xs || [], tolerance);
    var my = estimateModule(ys || [], tolerance);
    var moduleSize = null;
    if (mx !== null && my !== null) {
      moduleSize = approxGcd(mx, my, tolerance);
      if (!(moduleSize > tolerance)) {
        moduleSize = mx < my ? mx : my;
      }
    } else if (mx !== null) {
      moduleSize = mx;
    } else if (my !== null) {
      moduleSize = my;
    }
    if (!(moduleSize >= 2)) {
      moduleSize = fallbackModule(bounds);
    }
    return moduleSize;
  }
  api.measureModule = measureModule;

  function pointOnRectBoundary(p, bounds, eps) {
    var xMin = Math.min(bounds.left, bounds.right);
    var xMax = Math.max(bounds.left, bounds.right);
    var yMin = Math.min(bounds.top, bounds.bottom);
    var yMax = Math.max(bounds.top, bounds.bottom);
    var inX = p.x >= xMin - eps && p.x <= xMax + eps;
    var inY = p.y >= yMin - eps && p.y <= yMax + eps;
    var onV;
    var onH;
    if (!inX || !inY) {
      return false;
    }
    onV = Math.abs(p.x - xMin) <= eps || Math.abs(p.x - xMax) <= eps;
    onH = Math.abs(p.y - yMin) <= eps || Math.abs(p.y - yMax) <= eps;
    return onV || onH;
  }

  // Parallel lines at `angleDeg`, spaced `spacing` apart perpendicular to
  // the line, aligned so one line passes through `origin`. Each returned
  // segment is clipped to `bounds`. `truncated` is set when the cap cuts
  // the grid short (tiny module, huge artboard).
  function parallelLines(bounds, angleDegValue, spacing, origin, limit) {
    var rad = (angleDegValue * Math.PI) / 180;
    var dx = Math.cos(rad);
    var dy = Math.sin(rad);
    var px = -Math.sin(rad);
    var py = Math.cos(rad);
    var corners = [
      { x: Math.min(bounds.left, bounds.right), y: Math.min(bounds.top, bounds.bottom) },
      { x: Math.max(bounds.left, bounds.right), y: Math.min(bounds.top, bounds.bottom) },
      { x: Math.min(bounds.left, bounds.right), y: Math.max(bounds.top, bounds.bottom) },
      { x: Math.max(bounds.left, bounds.right), y: Math.max(bounds.top, bounds.bottom) }
    ];
    var minO = Infinity;
    var maxO = -Infinity;
    var i;
    var o;
    var start;
    var steps;
    var truncated = false;
    var lines = [];
    var point;
    var seg;
    var eps = 1e-4;

    function offset(p) {
      return (p.x - origin.x) * px + (p.y - origin.y) * py;
    }

    if (!(spacing > 0)) {
      return { lines: lines, truncated: false };
    }
    for (i = 0; i < corners.length; i++) {
      o = offset(corners[i]);
      if (o < minO) {
        minO = o;
      }
      if (o > maxO) {
        maxO = o;
      }
    }
    start = Math.floor(minO / spacing) * spacing;
    steps = Math.floor((maxO - start) / spacing + 1e-6);
    if (steps < 0) {
      steps = 0;
    }
    if (steps > limit) {
      truncated = true;
      steps = limit;
    }
    for (i = 0; i <= steps; i++) {
      o = start + i * spacing;
      point = { x: origin.x + px * o, y: origin.y + py * o };
      seg = extendSegmentToBounds(point, { x: point.x + dx, y: point.y + dy }, bounds);
      if (
        pointOnRectBoundary(seg.p1, bounds, eps) &&
        pointOnRectBoundary(seg.p2, bounds, eps) &&
        distance(seg.p1, seg.p2) > 0.5
      ) {
        lines.push(seg);
      }
    }
    return { lines: lines, truncated: truncated };
  }

  function hexagon(cx, cy, size) {
    var pts = [];
    var k;
    var ang;
    for (k = 0; k < 6; k++) {
      ang = ((60 * k - 30) * Math.PI) / 180;
      pts.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
    }
    return pts;
  }

  function hexGrid(bounds, size, origin) {
    var polygons = [];
    var truncated = false;
    var width = Math.sqrt(3) * size;
    var vert = 1.5 * size;
    var xMin = Math.min(bounds.left, bounds.right) - size;
    var xMax = Math.max(bounds.left, bounds.right) + size;
    var yMin = Math.min(bounds.top, bounds.bottom) - size;
    var yMax = Math.max(bounds.top, bounds.bottom) + size;
    var row0 = Math.floor((yMin - origin.y) / vert);
    var row1 = Math.ceil((yMax - origin.y) / vert);
    var r;
    var c;
    var cy;
    var cx;
    var rowOffset;
    var col0;
    var col1;

    for (r = row0; r <= row1; r++) {
      cy = origin.y + r * vert;
      rowOffset = r % 2 !== 0 ? width / 2 : 0;
      col0 = Math.floor((xMin - origin.x - rowOffset) / width);
      col1 = Math.ceil((xMax - origin.x - rowOffset) / width);
      for (c = col0; c <= col1; c++) {
        if (polygons.length >= MAX_BACKGROUND_POLYGONS) {
          return { polygons: polygons, truncated: true };
        }
        cx = origin.x + rowOffset + c * width;
        polygons.push(hexagon(cx, cy, size));
      }
    }
    return { polygons: polygons, truncated: truncated };
  }

  function appendLineSet(result, set) {
    var i;
    if (set.truncated) {
      result.truncated = true;
    }
    for (i = 0; i < set.lines.length; i++) {
      if (result.lines.length >= MAX_BACKGROUND_LINES) {
        result.truncated = true;
        return;
      }
      result.lines.push(set.lines[i]);
    }
  }

  // type: "square" | "isometric" | "hex" | "golden"
  // Square and isometric use `moduleSize` as the line spacing. Hex uses it
  // as the side length (center to vertex). Golden tiles rectangles of
  // width module*φ by height module.
  function buildBackground(type, bounds, moduleSize, origin) {
    var result = { lines: [], polygons: [], truncated: false };
    var limit = MAX_BACKGROUND_LINES;
    var hex;
    if (!(moduleSize > 0) || !bounds) {
      return result;
    }
    if (!origin) {
      origin = {
        x: Math.min(bounds.left, bounds.right),
        y: Math.min(bounds.top, bounds.bottom)
      };
    }
    if (type === "isometric") {
      appendLineSet(result, parallelLines(bounds, 30, moduleSize, origin, limit));
      appendLineSet(result, parallelLines(bounds, 90, moduleSize, origin, limit));
      appendLineSet(result, parallelLines(bounds, 150, moduleSize, origin, limit));
    } else if (type === "hex") {
      hex = hexGrid(bounds, moduleSize, origin);
      result.polygons = hex.polygons;
      result.truncated = hex.truncated;
    } else if (type === "golden") {
      appendLineSet(result, parallelLines(bounds, 0, moduleSize, origin, limit));
      appendLineSet(result, parallelLines(bounds, 90, moduleSize * PHI, origin, limit));
    } else {
      appendLineSet(result, parallelLines(bounds, 0, moduleSize, origin, limit));
      appendLineSet(result, parallelLines(bounds, 90, moduleSize, origin, limit));
    }
    return result;
  }
  api.buildBackground = buildBackground;

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
