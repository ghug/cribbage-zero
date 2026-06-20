/* Cribbage Zero device worker — the Web Worker (off the UI thread).
 * Runs self-play with the engine bundle; the main thread (worker.html) does all GitHub-free Worker-API
 * I/O. Backpressure: produces one batch per "start"/"next" message so at most one batch is in flight. */
importScripts("az_bundle.js");   // -> Net, CribGame, search, selfPlay, makeRng, netFromObj, … (globals)

let net = null, sims = 20, games = 10, cPuct = 1.5, running = false;
const rng = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);

function produce() {
  if (!running || !net) return;
  let samples = [];
  for (let g = 0; g < games; g++) samples = samples.concat(selfPlay(net, sims, cPuct, rng));
  postMessage({ type: "batch", samples });
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "ckpt") net = netFromObj(m.obj);                       // freshest net to play against
  else if (m.type === "start") { sims = m.sims; games = m.games; cPuct = m.cPuct || 1.5; running = true; produce(); }
  else if (m.type === "next") produce();                                // main thread finished uploading -> next batch
  else if (m.type === "stop") running = false;
};
