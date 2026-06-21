# Cribbage Zero

A from-scratch, AlphaZero-style self-play training project for cribbage — **tabula rasa**: the only
knowledge injected is the rules and the terminal reward. A network learns to play purely from its own
self-play games, guided by Information-Set MCTS.

This repo is the **training project**. The playable game + the strong heuristic engine live in the
companion repo `cribbage-trainer`; the self-play core here was lifted from it and is being grown into a
distributed trainer.

## Status

Built and working **mechanically**; the net currently trains to ~random strength on the compute tried so
far (the full-game horizon + a CPU-only budget starve the bootstrap). The point of this repo is the
**distributed training infrastructure** — fan self-play across many devices so the net can actually grow.

## Architecture (in progress)

```
  workers (phone browser / APK, and PCs)         a small Cloudflare Worker          one trainer
  - self-play games --POST /shard-------------->  (auth + CORS) --> D1 (SQLite)  <-- GitHub Action (cron):
  - GET /checkpoint  (play the latest net) <----                                     consume -> train -> publish
```

- **Self-play core** (`engine/az_net.js`, `az_game.js`, `az_mcts.js`, `az_common.js`): the network
  (value+policy MLP), the heads-up game environment, IS-MCTS+PUCT, and the self-play/train loop.
- **Scoring** (`src/engine.js`): vendored cribbage scoring/pegging primitives (browser-safe, no deps).
- *(coming)* `engine/az_sync.js` (Worker-API client), `worker.html` + Web Worker (the device worker GUI),
  `engine/az_trainer.js --remote` + a scheduled GitHub Action, a `worker-api/` Cloudflare Worker, and an
  optional Android worker APK.

## Run the core locally (single machine, no network)

```
node engine/az_net.js                       # self-tests (net gradient check)
node engine/az_game.js                      # self-tests (game env: 2000 random games)
node engine/az_mcts.js                      # self-tests (IS-MCTS mechanics)
```

## Contribute self-play from a computer

`local.html` (the on-device trainer) pulls the shared net from the GitHub `net` branch, self-plays +
trains, and pushes it back. `engine/az_contribute.js` is the **headless Node version of the same loop**,
so a computer can carry the training far faster than a phone:

```
CZ_TOKEN=<github-pat> node engine/az_contribute.js [gamesPerIter=500] [sims=50] [pushEvery=5] [graphEvery=10000]
node engine/az_contribute.js --dry          # pull + self-play + train, but NEVER push (safe smoke test)
```

- `CZ_TOKEN` — a GitHub PAT with **Contents: read+write** on the repo. `CZ_REPO` overrides the target
  (default `ghug/cribbage-zero`).
- **Multi-core:** it fans self-play across your CPU cores automatically — the main thread owns the net
  (training + sync) while N worker threads generate self-play in parallel. Override the worker count with
  `CZ_WORKERS` (default: cores − 1).
- It resumes from whatever the phone/another computer last pushed, and shares the **same** checkpoint
  format — so they're interchangeable.
- **It won't throw out the cloud net.** It only starts fresh when the branch genuinely has *no* net (a
  clean 404). If it can't read the net, or the net is a different architecture, it refuses to start —
  resetting the net is a deliberate manual act, not something a contributor can trip into.
- **Single-writer:** the net is one blob pushed with a force-push, so run **only one trainer at a time**
  (this *or* the phone, not both at once) — concurrent trainers overwrite each other's games. Ctrl-C does
  a final push before exiting.

License: public domain (The Unlicense), matching the companion project.
