// host/main.jsx
//
// The only file in this project that touches the Illustrator DOM. Expects
// host/geometry.jsx to already be loaded (so `Lattice.geometry` exists) —
// client/js/main.js guarantees the load order by $.evalFile-ing
// geometry.jsx immediately before this file on every call.
//
// This file is NOT covered by the Node test suite (it needs `app`, which
// only exists inside Illustrator). It is exercised manually; see the
// verification checklist in README.md.

var Lattice = Lattice || {};

// ExtendScript's JSON support is inconsistent across Illustrator versions.
// This trusted-input shim is only ever asked to parse JSON this project
// itself produced (the panel's own JSON.stringify output), so a permissive
// implementation is an acceptable tradeoff here.
if (typeof JSON === "undefined") {
  JSON = {};
}
if (typeof JSON.stringify !== "function") {
  JSON.stringify = function (value) {
    var type = typeof value;
    if (value === null) {
      return "null";
    }
    if (type === "number" || type === "boolean") {
      return String(value);
    }
    if (type === "string") {
      return (
        '"' +
        value
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n") +
        '"'
      );
    }
    if (value instanceof Array) {
      var items = [];
      for (var i = 0; i < value.length; i++) {
        items.push(JSON.stringify(value[i]));
      }
      return "[" + items.join(",") + "]";
    }
    if (type === "object") {
      var pairs = [];
      for (var key in value) {
        if (value.hasOwnProperty(key)) {
          pairs.push(JSON.stringify(key) + ":" + JSON.stringify(value[key]));
        }
      }
      return "{" + pairs.join(",") + "}";
    }
    return "null";
  };
}
if (typeof JSON.parse !== "function") {
  JSON.parse = function (text) {
    // Trusted input only (see note above) — this project's own panel JSON.
    return eval("(" + text + ")");
  };
}

Lattice.main = (function () {
  var LAYER_NAME = "Lattice";
  var SUBLAYER = {
    ANCHORS: "Anchors",
    HANDLES: "Handles",
    OUTLINE: "Outline",
    ALIGNMENTS: "Alignments",
    EDGES: "Edges",
    CIRCLES: "Circles",
    BACKGROUND: "Background"
  };

  function fail(message) {
    return JSON.stringify({ ok: false, error: message });
  }

  function removeExistingLayer(doc) {
    var i;
    var layer;
    for (i = doc.layers.length - 1; i >= 0; i--) {
      if (doc.layers[i].name === LAYER_NAME) {
        layer = doc.layers[i];
        // Guides can sit on this layer; unlock before remove so Clear
        // actually takes them with it.
        try {
          layer.locked = false;
          layer.visible = true;
        } catch (e) {}
        layer.remove();
      }
    }
  }

  function getOrCreateSublayer(parentLayer, name) {
    var i;
    for (i = 0; i < parentLayer.layers.length; i++) {
      if (parentLayer.layers[i].name === name) {
        return parentLayer.layers[i];
      }
    }
    var sub = parentLayer.layers.add();
    sub.name = name;
    return sub;
  }

  function hexToRGB(hex) {
    hex = hex.replace("#", "");
    var color = new RGBColor();
    color.red = parseInt(hex.substr(0, 2), 16);
    color.green = parseInt(hex.substr(2, 2), 16);
    color.blue = parseInt(hex.substr(4, 2), 16);
    return color;
  }

  // Best-effort filter: skip locked/hidden layers and items already turned
  // into Illustrator guides. `.guides` is documented on PathItem; verify
  // against the scripting reference for other item types during manual QA.
  function isSelectable(item) {
    if (item.locked || item.hidden) {
      return false;
    }
    if (item.guides) {
      return false;
    }
    return true;
  }

  // Recursively collects PathItems from a selection, descending into
  // GroupItems and CompoundPathItems, skipping locked/hidden/guide items.
  function collectPaths(items, out) {
    var i, item;
    for (i = 0; i < items.length; i++) {
      item = items[i];
      if (!isSelectable(item)) {
        continue;
      }
      if (item.typename === "PathItem") {
        out.push(item);
      } else if (item.typename === "GroupItem") {
        collectPaths(item.pageItems, out);
      } else if (item.typename === "CompoundPathItem") {
        collectPaths(item.pathItems, out);
      }
    }
  }

  // Illustrator's document coordinate space has y increasing upward, so
  // "top" is numerically greater than "bottom" — same convention used by
  // geometricBounds / artboardRect, kept consistently through to
  // host/geometry.jsx's bounds objects.
  function selectionBounds(paths, margin) {
    var left = Infinity;
    var top = -Infinity;
    var right = -Infinity;
    var bottom = Infinity;
    var i, gb;
    for (i = 0; i < paths.length; i++) {
      gb = paths[i].geometricBounds; // [left, top, right, bottom]
      if (gb[0] < left) left = gb[0];
      if (gb[1] > top) top = gb[1];
      if (gb[2] > right) right = gb[2];
      if (gb[3] < bottom) bottom = gb[3];
    }
    return {
      left: left - margin,
      top: top + margin,
      right: right + margin,
      bottom: bottom - margin
    };
  }

  function artboardBounds(doc) {
    var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
    var r = ab.artboardRect; // [left, top, right, bottom]
    return { left: r[0], top: r[1], right: r[2], bottom: r[3] };
  }

  function drawDot(layer, point, size, color) {
    var half = size / 2;
    var circle = layer.pathItems.ellipse(point.y + half, point.x - half, size, size);
    circle.filled = true;
    circle.fillColor = color;
    circle.stroked = false;
    circle.name = "lattice-dot";
    return circle;
  }

  function drawLine(layer, p1, p2, weight, color) {
    if (Lattice.geometry.distance(p1, p2) < 0.01) {
      return null;
    }
    var line = layer.pathItems.add();
    line.setEntirePath([
      [p1.x, p1.y],
      [p2.x, p2.y]
    ]);
    line.filled = false;
    line.stroked = true;
    line.strokeColor = color;
    line.strokeWidth = weight;
    line.name = "lattice-stroke";
    return line;
  }

  // pathItems.ellipse(top, left, width, height). Illustrator y grows upward,
  // so `top` is the visually upper edge: center.y + radius.
  function drawCircle(layer, center, radius, weight, color) {
    var d = radius * 2;
    var ellipse = layer.pathItems.ellipse(center.y + radius, center.x - radius, d, d);
    ellipse.filled = false;
    ellipse.stroked = true;
    ellipse.strokeColor = color;
    ellipse.strokeWidth = weight;
    ellipse.name = "lattice-circle";
    return ellipse;
  }

  function drawPolygon(layer, points, weight, color) {
    var path = layer.pathItems.add();
    var coords = [];
    var i;
    for (i = 0; i < points.length; i++) {
      coords.push([points[i].x, points[i].y]);
    }
    path.setEntirePath(coords);
    path.closed = true;
    path.filled = false;
    path.stroked = true;
    path.strokeColor = color;
    path.strokeWidth = weight;
    path.name = "lattice-stroke";
    return path;
  }

  function num(value, fallback) {
    if (typeof value !== "number" || isNaN(value)) {
      return fallback;
    }
    return value;
  }

  function layerOn(options, name) {
    return !!(options.layers && options.layers[name] && options.layers[name].enabled);
  }

  function layerColor(options, name, fallback) {
    if (options.layers && options.layers[name] && options.layers[name].color) {
      return options.layers[name].color;
    }
    return fallback;
  }

  function itemBounds(item) {
    var gb = item.geometricBounds;
    return { left: gb[0], top: gb[1], right: gb[2], bottom: gb[3] };
  }

  function findLayer(doc, name) {
    var i;
    for (i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].name === name) {
        return doc.layers[i];
      }
    }
    return null;
  }

  function findSublayer(parent, name) {
    var i;
    for (i = 0; i < parent.layers.length; i++) {
      if (parent.layers[i].name === name) {
        return parent.layers[i];
      }
    }
    return null;
  }

  function removeIfEmpty(layer) {
    if (!layer) {
      return;
    }
    try {
      if (layer.pageItems.length === 0) {
        layer.remove();
      }
    } catch (e) {}
  }

  function tryMakeGuide(item) {
    if (!item) {
      return false;
    }
    try {
      item.guides = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function resizeDot(item, target) {
    var gb = item.geometricBounds;
    var w = Math.abs(gb[2] - gb[0]);
    var h = Math.abs(gb[1] - gb[3]);
    var current = w > h ? w : h;
    var pct;
    if (!(current > 0) || !(target > 0)) {
      return;
    }
    pct = (target / current) * 100;
    if (Math.abs(pct - 100) < 0.05) {
      return;
    }
    // Last argument keeps stroke widths put; dots are filled, not stroked.
    item.resize(pct, pct, true, true, true, true, 100, Transformation.CENTER);
  }

  function restyleLayer(layer, colorHex, dotSize, weight) {
    var color;
    var i;
    var item;
    var n = 0;
    if (!layer) {
      return 0;
    }
    try {
      layer.locked = false;
    } catch (e) {}
    color = hexToRGB(colorHex);
    for (i = 0; i < layer.pathItems.length; i++) {
      item = layer.pathItems[i];
      // Guide color is an Illustrator preference, not a per-path stroke.
      if (item.guides) {
        continue;
      }
      try {
        if (item.filled) {
          item.fillColor = color;
          if (dotSize) {
            resizeDot(item, dotSize);
          }
        }
        if (item.stroked) {
          item.strokeColor = color;
          if (weight > 0) {
            item.strokeWidth = weight;
          }
        }
        n += 1;
      } catch (err) {}
    }
    return n;
  }

  function generate(optionsJson) {
    var options;
    try {
      options = JSON.parse(optionsJson);
    } catch (e) {
      return fail("Could not parse options: " + e.message);
    }

    if (app.documents.length === 0) {
      return fail("No open document.");
    }
    var doc = app.activeDocument;

    if (app.selection.length === 0) {
      return fail("Select the logo artwork first.");
    }

    var paths = [];
    collectPaths(app.selection, paths);
    if (paths.length === 0) {
      return fail("Selection has no usable paths (groups/compound paths are followed, but none contained a path).");
    }

    // Replace-on-regenerate: one evalScript call = one Illustrator history
    // state as long as nothing forces an intermediate redraw, so deleting
    // the old Lattice layer and drawing the new one here stays a single
    // undo step from the user's perspective.
    removeExistingLayer(doc);

    var root = doc.layers.add();
    root.name = LAYER_NAME;

    var bounds =
      options.scope.mode === "artboard" ? artboardBounds(doc) : selectionBounds(paths, options.scope.margin);

    var drawnCount = 0;
    var allAnchors = [];
    var allEdges = [];
    var pathGeoms = [];
    var pi, pts, j, pp, anchor, leftH, rightH, nextPp;
    var asGuides = !!(options.guides && options.guides.alignments);
    var guideCount = 0;

    // Created back-to-front: each layers.add() lands at the top of the
    // stack, so the last sublayer (anchors) paints above the grid.
    var backgroundLayer, alignmentsLayer, edgesLayer, circlesLayer, outlineLayer, handlesLayer, anchorsLayer;
    if (layerOn(options, "background")) {
      backgroundLayer = getOrCreateSublayer(root, SUBLAYER.BACKGROUND);
    }
    if (layerOn(options, "alignments")) {
      alignmentsLayer = getOrCreateSublayer(root, SUBLAYER.ALIGNMENTS);
    }
    if (layerOn(options, "edges")) {
      edgesLayer = getOrCreateSublayer(root, SUBLAYER.EDGES);
    }
    if (layerOn(options, "circles")) {
      circlesLayer = getOrCreateSublayer(root, SUBLAYER.CIRCLES);
    }
    if (layerOn(options, "outline")) {
      outlineLayer = getOrCreateSublayer(root, SUBLAYER.OUTLINE);
    }
    if (layerOn(options, "handles")) {
      handlesLayer = getOrCreateSublayer(root, SUBLAYER.HANDLES);
    }
    if (layerOn(options, "anchors")) {
      anchorsLayer = getOrCreateSublayer(root, SUBLAYER.ANCHORS);
    }

    for (pi = 0; pi < paths.length; pi++) {
      pts = paths[pi].pathPoints;
      var cubics = [];
      var pathBound = null;
      try {
        pathBound = itemBounds(paths[pi]);
      } catch (e) {}

      if (outlineLayer) {
        var dup = paths[pi].duplicate(outlineLayer, ElementPlacement.PLACEATEND);
        dup.filled = false;
        dup.stroked = true;
        dup.strokeColor = hexToRGB(layerColor(options, "outline", "#007aff"));
        dup.strokeWidth = options.lineWeight;
        dup.name = "lattice-stroke";
        drawnCount++;
      }

      for (j = 0; j < pts.length; j++) {
        pp = pts[j];
        anchor = { x: pp.anchor[0], y: pp.anchor[1] };
        allAnchors.push(anchor);

        if (anchorsLayer) {
          drawDot(anchorsLayer, anchor, options.layers.anchors.size, hexToRGB(layerColor(options, "anchors", "#ff3b30")));
          drawnCount++;
        }

        if (handlesLayer) {
          leftH = { x: pp.leftDirection[0], y: pp.leftDirection[1] };
          rightH = { x: pp.rightDirection[0], y: pp.rightDirection[1] };
          if (Lattice.geometry.hasHandle(anchor, leftH)) {
            drawLine(handlesLayer, anchor, leftH, options.lineWeight, hexToRGB(layerColor(options, "handles", "#34c759")));
            drawDot(handlesLayer, leftH, options.layers.handles.size, hexToRGB(layerColor(options, "handles", "#34c759")));
            drawnCount += 2;
          }
          if (Lattice.geometry.hasHandle(anchor, rightH)) {
            drawLine(handlesLayer, anchor, rightH, options.lineWeight, hexToRGB(layerColor(options, "handles", "#34c759")));
            drawDot(handlesLayer, rightH, options.layers.handles.size, hexToRGB(layerColor(options, "handles", "#34c759")));
            drawnCount += 2;
          }
        }

        // Straight-segment edge candidate: anchor[j] -> anchor[j+1], only
        // when neither side pulls a handle into that segment (i.e. it's
        // genuinely straight, not a curve that happens to look flat).
        // Curved segments are circle candidates instead.
        if (j + 1 < pts.length || paths[pi].closed) {
          nextPp = pts[(j + 1) % pts.length];
          var nextAnchor = { x: nextPp.anchor[0], y: nextPp.anchor[1] };
          var rightHandleOut = { x: pp.rightDirection[0], y: pp.rightDirection[1] };
          var leftHandleIn = { x: nextPp.leftDirection[0], y: nextPp.leftDirection[1] };
          var isStraight =
            !Lattice.geometry.hasHandle(anchor, rightHandleOut) &&
            !Lattice.geometry.hasHandle(nextAnchor, leftHandleIn);
          if (isStraight && Lattice.geometry.distance(anchor, nextAnchor) >= options.sensitivity.minEdgeLength) {
            allEdges.push({ p1: anchor, p2: nextAnchor });
          } else if (!isStraight) {
            cubics.push({
              p0: anchor,
              p1: rightHandleOut,
              p2: leftHandleIn,
              p3: nextAnchor
            });
          }
        }
      }

      pathGeoms.push({ bounds: pathBound, cubics: cubics });
    }

    if (edgesLayer && allEdges.length > 0) {
      var mergedEdges = Lattice.geometry.mergeParallelLines(
        allEdges,
        options.sensitivity.angleToleranceDeg,
        options.sensitivity.coordTolerance
      );
      for (var e = 0; e < mergedEdges.length; e++) {
        var extended = Lattice.geometry.extendSegmentToBounds(mergedEdges[e].line.p1, mergedEdges[e].line.p2, bounds);
        drawLine(edgesLayer, extended.p1, extended.p2, options.lineWeight, hexToRGB(options.layers.edges.color));
        drawnCount++;
      }
    }

    var coordTolerance = num(options.sensitivity && options.sensitivity.coordTolerance, 1);
    var alignGroups = null;
    if (allAnchors.length > 0) {
      alignGroups = Lattice.geometry.groupAlignments(allAnchors, coordTolerance);
    }

    if (alignmentsLayer && alignGroups) {
      var g;
      var alignColor = hexToRGB(layerColor(options, "alignments", "#ffcc00"));
      for (g = 0; g < alignGroups.vertical.length; g++) {
        var vx = alignGroups.vertical[g].value;
        var vLine = drawLine(
          alignmentsLayer,
          { x: vx, y: bounds.bottom },
          { x: vx, y: bounds.top },
          options.lineWeight,
          alignColor
        );
        if (asGuides && tryMakeGuide(vLine)) {
          guideCount++;
        }
        drawnCount++;
      }
      for (g = 0; g < alignGroups.horizontal.length; g++) {
        var hy = alignGroups.horizontal[g].value;
        var hLine = drawLine(
          alignmentsLayer,
          { x: bounds.left, y: hy },
          { x: bounds.right, y: hy },
          options.lineWeight,
          alignColor
        );
        if (asGuides && tryMakeGuide(hLine)) {
          guideCount++;
        }
        drawnCount++;
      }
    }

    var circleSummaries = [];
    if (circlesLayer && pathGeoms.length > 0) {
      var circleOpts = options.circles || {};
      var display = circleOpts.display || {};
      var fitted = Lattice.geometry.fitCircles(pathGeoms, {
        minRadius: num(circleOpts.minRadius, 8),
        minChord: num(circleOpts.minChord, 15),
        tolerance: num(circleOpts.tolerance, 0.03),
        crossPathFactor: 0.5
      });
      var shown = Lattice.geometry.filterCircles(fitted, {
        mode: display.mode || "all",
        count: num(display.count, 5),
        maxError: num(display.maxError, 0.01)
      });
      var circleColor = hexToRGB(layerColor(options, "circles", "#ff9500"));
      var c;
      for (c = 0; c < shown.length; c++) {
        drawCircle(circlesLayer, shown[c].center, shown[c].radius, options.lineWeight, circleColor);
        circleSummaries.push({
          radius: shown[c].radius,
          error: shown[c].error,
          arcLength: shown[c].arcLength,
          members: shown[c].members
        });
        drawnCount++;
      }
    }

    var tight = selectionBounds(paths, 0);
    var moduleXs = [];
    var moduleYs = [];
    if (alignGroups) {
      var a;
      for (a = 0; a < alignGroups.vertical.length; a++) {
        moduleXs.push(alignGroups.vertical[a].value);
      }
      for (a = 0; a < alignGroups.horizontal.length; a++) {
        moduleYs.push(alignGroups.horizontal[a].value);
      }
    }
    var moduleSize = Lattice.geometry.measureModule(moduleXs, moduleYs, tight, coordTolerance);
    var backgroundTruncated = false;
    if (backgroundLayer) {
      var origin = {
        x: Math.min(tight.left, tight.right),
        y: Math.min(tight.top, tight.bottom)
      };
      var bgType = "square";
      if (options.background && options.background.type) {
        bgType = options.background.type;
      }
      var grid = Lattice.geometry.buildBackground(bgType, bounds, moduleSize, origin);
      var bgColor = hexToRGB(layerColor(options, "background", "#8e8e93"));
      var b;
      backgroundTruncated = !!grid.truncated;
      for (b = 0; b < grid.lines.length; b++) {
        drawLine(backgroundLayer, grid.lines[b].p1, grid.lines[b].p2, options.lineWeight, bgColor);
        drawnCount++;
      }
      for (b = 0; b < grid.polygons.length; b++) {
        drawPolygon(backgroundLayer, grid.polygons[b], options.lineWeight, bgColor);
        drawnCount++;
      }
    }

    removeIfEmpty(backgroundLayer);
    // Keep this layer once it holds guides. After guides is set, the path
    // may no longer show up in pageItems, and removing the layer deletes them.
    if (guideCount === 0) {
      removeIfEmpty(alignmentsLayer);
    }
    removeIfEmpty(edgesLayer);
    removeIfEmpty(circlesLayer);
    removeIfEmpty(outlineLayer);
    removeIfEmpty(handlesLayer);
    removeIfEmpty(anchorsLayer);

    // The numeric audit report (tier 3) will add a `deviations` list later.
    return JSON.stringify({
      ok: true,
      drawn: drawnCount,
      paths: paths.length,
      anchors: allAnchors.length,
      edges: allEdges.length,
      circles: circleSummaries,
      guides: guideCount,
      module: moduleSize,
      backgroundTruncated: backgroundTruncated
    });
  }

  // Recolors, resizes dots, and restrokes existing Lattice geometry.
  // Does not refit circles, rebuild the grid, or convert lines into guides —
  // those change which objects exist, so they belong to Generate.
  function updateAppearance(optionsJson) {
    var options;
    try {
      options = JSON.parse(optionsJson);
    } catch (e) {
      return fail("Could not parse options: " + e.message);
    }
    if (app.documents.length === 0) {
      return fail("No open document.");
    }
    var doc = app.activeDocument;
    var root = findLayer(doc, LAYER_NAME);
    if (!root) {
      return fail("Nothing to update. Generate a grid first.");
    }
    try {
      root.locked = false;
      root.visible = true;
    } catch (e) {}

    var weight = num(options.lineWeight, 0.5);
    var jobs = [
      { name: SUBLAYER.ANCHORS, key: "anchors", dots: true },
      { name: SUBLAYER.HANDLES, key: "handles", dots: true },
      { name: SUBLAYER.OUTLINE, key: "outline" },
      { name: SUBLAYER.ALIGNMENTS, key: "alignments" },
      { name: SUBLAYER.EDGES, key: "edges" },
      { name: SUBLAYER.CIRCLES, key: "circles" },
      { name: SUBLAYER.BACKGROUND, key: "background" }
    ];
    var updated = 0;
    var i;
    var job;
    var spec;
    var dotSize;
    for (i = 0; i < jobs.length; i++) {
      job = jobs[i];
      spec = options.layers && options.layers[job.key];
      if (!spec) {
        continue;
      }
      dotSize = job.dots ? num(spec.size, 0) : 0;
      updated += restyleLayer(findSublayer(root, job.name), spec.color || "#888888", dotSize, weight);
    }
    return JSON.stringify({ ok: true, updated: updated });
  }

  function clear() {
    if (app.documents.length === 0) {
      return fail("No open document.");
    }
    var doc = app.activeDocument;
    var before = doc.layers.length;
    removeExistingLayer(doc);
    return JSON.stringify({ ok: true, removed: before - doc.layers.length });
  }

  return { generate: generate, updateAppearance: updateAppearance, clear: clear };
})();
