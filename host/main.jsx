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
    EDGES: "Edges"
  };

  function fail(message) {
    return JSON.stringify({ ok: false, error: message });
  }

  function removeExistingLayer(doc) {
    var i;
    for (i = doc.layers.length - 1; i >= 0; i--) {
      if (doc.layers[i].name === LAYER_NAME) {
        doc.layers[i].remove();
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
  }

  function drawLine(layer, p1, p2, weight, color) {
    var line = layer.pathItems.add();
    line.setEntirePath([
      [p1.x, p1.y],
      [p2.x, p2.y]
    ]);
    line.filled = false;
    line.stroked = true;
    line.strokeColor = color;
    line.strokeWidth = weight;
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
    var pi, pts, j, pp, anchor, leftH, rightH, nextPp;

    var anchorsLayer, handlesLayer, outlineLayer, alignmentsLayer, edgesLayer;
    if (options.layers.anchors.enabled) {
      anchorsLayer = getOrCreateSublayer(root, SUBLAYER.ANCHORS);
    }
    if (options.layers.handles.enabled) {
      handlesLayer = getOrCreateSublayer(root, SUBLAYER.HANDLES);
    }
    if (options.layers.outline.enabled) {
      outlineLayer = getOrCreateSublayer(root, SUBLAYER.OUTLINE);
    }
    if (options.layers.alignments.enabled) {
      alignmentsLayer = getOrCreateSublayer(root, SUBLAYER.ALIGNMENTS);
    }
    if (options.layers.edges.enabled) {
      edgesLayer = getOrCreateSublayer(root, SUBLAYER.EDGES);
    }

    for (pi = 0; pi < paths.length; pi++) {
      pts = paths[pi].pathPoints;

      if (outlineLayer) {
        var dup = paths[pi].duplicate(outlineLayer, ElementPlacement.PLACEATEND);
        dup.filled = false;
        dup.stroked = true;
        dup.strokeColor = hexToRGB(options.layers.outline.color);
        dup.strokeWidth = options.lineWeight;
        drawnCount++;
      }

      for (j = 0; j < pts.length; j++) {
        pp = pts[j];
        anchor = { x: pp.anchor[0], y: pp.anchor[1] };
        allAnchors.push(anchor);

        if (anchorsLayer) {
          drawDot(anchorsLayer, anchor, options.layers.anchors.size, hexToRGB(options.layers.anchors.color));
          drawnCount++;
        }

        if (handlesLayer) {
          leftH = { x: pp.leftDirection[0], y: pp.leftDirection[1] };
          rightH = { x: pp.rightDirection[0], y: pp.rightDirection[1] };
          if (Lattice.geometry.hasHandle(anchor, leftH)) {
            drawLine(handlesLayer, anchor, leftH, options.lineWeight, hexToRGB(options.layers.handles.color));
            drawDot(handlesLayer, leftH, options.layers.handles.size, hexToRGB(options.layers.handles.color));
            drawnCount += 2;
          }
          if (Lattice.geometry.hasHandle(anchor, rightH)) {
            drawLine(handlesLayer, anchor, rightH, options.lineWeight, hexToRGB(options.layers.handles.color));
            drawDot(handlesLayer, rightH, options.layers.handles.size, hexToRGB(options.layers.handles.color));
            drawnCount += 2;
          }
        }

        // Straight-segment edge candidate: anchor[j] -> anchor[j+1], only
        // when neither side pulls a handle into that segment (i.e. it's
        // genuinely straight, not a curve that happens to look flat).
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
          }
        }
      }
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

    if (alignmentsLayer && allAnchors.length > 0) {
      var groups = Lattice.geometry.groupAlignments(allAnchors, options.sensitivity.coordTolerance);
      var g;
      for (g = 0; g < groups.vertical.length; g++) {
        var vx = groups.vertical[g].value;
        drawLine(
          alignmentsLayer,
          { x: vx, y: bounds.bottom },
          { x: vx, y: bounds.top },
          options.lineWeight,
          hexToRGB(options.layers.alignments.color)
        );
        drawnCount++;
      }
      for (g = 0; g < groups.horizontal.length; g++) {
        var hy = groups.horizontal[g].value;
        drawLine(
          alignmentsLayer,
          { x: bounds.left, y: hy },
          { x: bounds.right, y: hy },
          options.lineWeight,
          hexToRGB(options.layers.alignments.color)
        );
        drawnCount++;
      }
    }

    // NOTE: circle fitting (tier 2, `circles` todo) and the numeric audit
    // report (tier 3, `audit` todo) are not implemented yet. This return
    // shape will grow a `circles` array and a `deviations` list later
    // without breaking the fields already here.
    return JSON.stringify({
      ok: true,
      drawn: drawnCount,
      paths: paths.length,
      anchors: allAnchors.length,
      edges: allEdges.length
    });
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

  return { generate: generate, clear: clear };
})();
