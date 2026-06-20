/* Cribbage Zero device worker — the Web Worker (off the UI thread).
 * Self-clocks: accumulates self-play samples and posts a batch every `flushMs` (or at `maxSamples`),
 * so upload cadence is predictable regardless of device speed. The main thread (worker.html) does all
 * Worker-API I/O. On "wind" it posts its current batch then reports "wound"; on "stop" it just stops. */
importScripts("az_bundle.js");   // -> Net, CribGame, search, selfPlay, makeRng, netFromObj, … (globals)

var net = null, sims = 20, cPuct = 1.5, flushMs = 300000, maxSamples = 2000, running = false, winding = false;
var rng = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);

async function loop() {
  var buf = [], t0 = Date.now();
  while (running) {
    if (net) buf = buf.concat(selfPlay(net, sims, cPuct, rng));
    while (buf.length >= maxSamples) postMessage({ type: "batch", samples: buf.splice(0, maxSamples) });   // each full chunk
    if (Date.now() - t0 >= flushMs) { if (buf.length) postMessage({ type: "batch", samples: buf.splice(0) }); t0 = Date.now(); }
    if (winding) { if (buf.length) postMessage({ type: "batch", samples: buf.splice(0) }); running = false; postMessage({ type: "wound" }); break; }
    await new Promise(function (r) { setTimeout(r, 0); });
  }
}

onmessage = function (e) {
  var m = e.data;
  if (m.type === "ckpt") net = netFromObj(m.obj);
  else if (m.type === "start") { sims = m.sims; cPuct = m.cPuct || 1.5; flushMs = m.flushMs || 300000; maxSamples = m.maxSamples || 2000; if (!running) { running = true; winding = false; loop(); } }
  else if (m.type === "wind") winding = true;     // finish the current batch, post it, then stop
  else if (m.type === "stop") { running = false; winding = false; }
};
