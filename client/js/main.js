// client/js/main.js
//
// CEP panel logic: reads the form, bridges to ExtendScript via CSInterface,
// and renders whatever JSON report host/main.jsx hands back.

(function () {
  "use strict";

  var csInterface = new CSInterface();
  var STORAGE_KEY = "lattice.options.v1";

  var statusEl = document.getElementById("status");
  var reportEl = document.getElementById("report");
  var reportBodyEl = document.getElementById("report-body");

  function persistOptions() {
    var data = {};
    var inputs = document.querySelectorAll("#options-form input, #options-form select");
    var i;
    var el;
    for (i = 0; i < inputs.length; i++) {
      el = inputs[i];
      if (!el.id) {
        continue;
      }
      data[el.id] = el.type === "checkbox" ? el.checked : el.value;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      // CEP can deny storage; the panel still works for this session.
    }
  }

  function restoreOptions() {
    var raw;
    var data;
    var id;
    var el;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return;
    }
    if (!raw) {
      return;
    }
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return;
    }
    for (id in data) {
      if (!Object.prototype.hasOwnProperty.call(data, id)) {
        continue;
      }
      el = document.getElementById(id);
      if (!el) {
        continue;
      }
      if (el.type === "checkbox") {
        el.checked = !!data[id];
      } else {
        el.value = data[id];
      }
    }
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function showReport(data) {
    reportEl.hidden = false;
    reportBodyEl.textContent = JSON.stringify(data, null, 2);
  }

  function readOptions() {
    function checked(id) {
      return document.getElementById(id).checked;
    }
    function value(id) {
      return document.getElementById(id).value;
    }
    function number(id) {
      return parseFloat(value(id));
    }

    return {
      layers: {
        anchors: { enabled: checked("layer-anchors"), color: value("color-anchors"), size: number("size-anchors") },
        handles: { enabled: checked("layer-handles"), color: value("color-handles"), size: number("size-handles") },
        outline: { enabled: checked("layer-outline"), color: value("color-outline") },
        alignments: { enabled: checked("layer-alignments"), color: value("color-alignments") },
        edges: { enabled: checked("layer-edges"), color: value("color-edges") },
        circles: { enabled: checked("layer-circles"), color: value("color-circles") },
        background: { enabled: checked("layer-background"), color: value("color-background") }
      },
      lineWeight: number("line-weight"),
      sensitivity: {
        angleToleranceDeg: number("angle-tolerance"),
        coordTolerance: number("coord-tolerance"),
        minEdgeLength: number("min-edge-length"),
        highSensitivity: checked("high-sensitivity")
      },
      scope: {
        mode: value("scope-mode"), // "artboard" | "selection"
        margin: number("scope-margin")
      },
      circles: {
        minRadius: number("circle-min-radius"),
        minChord: number("circle-min-chord"),
        tolerance: number("circle-tolerance") / 100,
        display: {
          mode: value("circle-display"), // "all" | "longest" | "error"
          count: number("circle-longest-n"),
          maxError: number("circle-max-error") / 100
        }
      },
      background: {
        type: value("background-type") // "square" | "isometric" | "hex" | "golden"
      },
      guides: {
        alignments: checked("alignments-as-guides")
      }
    };
  }

  // Illustrator's ExtendScript engine doesn't persist #include'd files
  // between evalScript calls in a predictable way across every host
  // version, so the bootstrap re-includes geometry.jsx + main.jsx (both
  // idempotent, side-effect-free at parse time) before every call that
  // needs them.
  function bootstrap(extensionRoot) {
    var geometryPath = extensionRoot + "/host/geometry.jsx";
    var mainPath = extensionRoot + "/host/main.jsx";
    // Paths are embedded as string literals; escape backslashes for Windows.
    function esc(p) {
      return p.replace(/\\/g, "\\\\");
    }
    return (
      '$.evalFile("' + esc(geometryPath) + '");' +
      '$.evalFile("' + esc(mainPath) + '");'
    );
  }

  function callHost(expression, callback) {
    var extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var script = bootstrap(extensionRoot) + expression;
    csInterface.evalScript(script, function (result) {
      var parsed;
      try {
        parsed = JSON.parse(result);
      } catch (err) {
        callback({ ok: false, error: "Unexpected response from Illustrator: " + result });
        return;
      }
      callback(parsed);
    });
  }

  function onGenerateResult(result) {
    var parts;
    if (!result || result.ok === false) {
      setStatus((result && result.error) || "Generate failed.", "error");
      return;
    }
    parts = ["Generated " + result.drawn + " elements"];
    if (result.circles && result.circles.length) {
      parts.push(result.circles.length + (result.circles.length === 1 ? " circle" : " circles"));
    }
    if (result.guides) {
      parts.push(result.guides + (result.guides === 1 ? " guide" : " guides"));
    }
    if (typeof result.module === "number") {
      parts.push("module " + result.module.toFixed(2) + " pt");
    }
    if (result.backgroundTruncated) {
      parts.push("background grid capped");
    }
    setStatus(parts.join(" · ") + ".", "ok");
    showReport(result);
  }

  function onUpdateResult(result) {
    if (!result || result.ok === false) {
      setStatus((result && result.error) || "Update failed.", "error");
      return;
    }
    setStatus("Updated style on " + result.updated + " elements.", "ok");
  }

  function onClearResult(result) {
    if (!result || result.ok === false) {
      setStatus((result && result.error) || "Clear failed.", "error");
      return;
    }
    setStatus("Lattice layers cleared.", "ok");
    reportEl.hidden = true;
  }

  document.getElementById("btn-generate").addEventListener("click", function () {
    setStatus("Generating…");
    persistOptions();
    var options = readOptions();
    callHost("Lattice.main.generate(" + JSON.stringify(JSON.stringify(options)) + ");", onGenerateResult);
  });

  document.getElementById("btn-update").addEventListener("click", function () {
    setStatus("Updating style…");
    persistOptions();
    var options = readOptions();
    callHost(
      "Lattice.main.updateAppearance(" + JSON.stringify(JSON.stringify(options)) + ");",
      onUpdateResult
    );
  });

  document.getElementById("btn-clear").addEventListener("click", function () {
    setStatus("Clearing…");
    callHost("Lattice.main.clear();", onClearResult);
  });

  document.getElementById("options-form").addEventListener("change", persistOptions);

  restoreOptions();
  setStatus("Select a logo in Illustrator, then click Generate.");
})();
