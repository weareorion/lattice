// client/js/main.js
//
// CEP panel logic: reads the form, bridges to ExtendScript via CSInterface,
// and renders whatever JSON report host/main.jsx hands back.

(function () {
  "use strict";

  var csInterface = new CSInterface();

  var statusEl = document.getElementById("status");
  var reportEl = document.getElementById("report");
  var reportBodyEl = document.getElementById("report-body");

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
        edges: { enabled: checked("layer-edges"), color: value("color-edges") }
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
    if (!result || result.ok === false) {
      setStatus((result && result.error) || "Generate failed.", "error");
      return;
    }
    setStatus("Generated " + (result.drawn ? result.drawn + " elements." : "."), "ok");
    showReport(result);
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
    var options = readOptions();
    callHost("Lattice.main.generate(" + JSON.stringify(JSON.stringify(options)) + ");", onGenerateResult);
  });

  document.getElementById("btn-clear").addEventListener("click", function () {
    setStatus("Clearing…");
    callHost("Lattice.main.clear();", onClearResult);
  });

  setStatus("Select a logo in Illustrator, then click Generate.");
})();
