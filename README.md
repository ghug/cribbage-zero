# Cribbage Zero

A from-scratch self-play training project for cribbage — **tabula rasa**: the only knowledge injected is
the rules and the terminal reward. A neural network learns to play purely from its own self-play games,
guided by Information-Set Monte-Carlo Tree Search.

This repo is the **training project**. The playable game + the strong heuristic engine live in the
companion repo `cribbage-trainer`; the self-play core here was lifted from it and grown into a distributed
trainer with a native C++ engine.

## Status

Built, working, and **improving**. The engine, the distributed data bus, the PC learner, the Android
background actor, and the release pipeline are all shipped and verified. The net trains from random and its
strength climbs with games (it comfortably beats a random opponent; matching the strong hand-crafted
heuristic is the long road — that's an open question of how far self-play scales here, not whether the loop
works). The point of this repo is the **distributed training infrastructure** — fan self-play across many
devices (PCs + phones) so the net can keep growing.

## Architecture

```
  actors  (PC: cz_pc --actor · Android: native background service)        one learner (a PC)
    - self-play games ── POST /shard ─►  Cloudflare Worker + D1 (the bus) ◄── cz_pc: drain → train →
    - GET net (GitHub raw) ◄───────────────────────────────────────────────   push net → GitHub `net` branch
```

- **Engine** (`core/` — C++, header-only): the value+policy MLP (forward + backprop/SGD), the heads-up
  game environment + a clean 247-dim encoding, IS-MCTS + PUCT, self-play, and the replay buffer. The
  headless learner/actor CLI is `pc/` → **`cz_pc`** (libcurl + vendored nlohmann/json). This is the single
  fastest engine and also compiles for **Android via the NDK** (`android/app/src/main/cpp/` → `libczactor.so`),
  driven by a foreground service for background self-play on a phone.
- **The bus** (`worker-api/` — Cloudflare Worker + D1): an auth + CORS boundary over a shard queue. Actors
  `POST /shard`; the one learner drains + prunes and holds a **single-writer lease** so two learners can't
  fight over the net. The net itself lives on the GitHub `net` branch (not the bus).
- **Browser = observers** (no in-browser self-play): `dev.html` (hub), `worker.html` (read-only training
  **monitor** — net progress, bus depth, learner-lease status), `actor.html` (controls the Android native
  actor, app-only), `eval.html` (strength eval vs random/hard → `progress` branch), `progress.html` (graphs),
  plus the GitHub-API admin pages (`snapshot`/`refresh-trainer`/`release-trainer`).
- **Vendored JS** (`engine/az_net.js`/`az_game.js`/`az_mcts.js`/`az_common.js` → `worker/az_bundle.js`):
  a browser port of the engine, now used **only by `eval.html`** to run the net in the browser. `src/engine.js`
  / `src/winprob.js` provide the scoring + heuristic "hard bot" baseline for eval.

## Run the engine locally (single machine, no network)

```
cmake -B core/build -S core && cmake --build core/build -j   # build (needs libcurl)
ctest --test-dir core/build                                  # scoring, net gradient check, MCTS, self-play, actor loop, orchestration
core/build/cz_pc --dry                                        # multi-core local self-play bench (add --fresh to start over)
```

## Contribute self-play

- **From a PC** — run **`cz_pc`** (see `docs/BUS.md`): as the **learner** it pulls the net, self-plays,
  trains a replay buffer, drains the bus, and pushes the net; with `--actor` it only self-plays and uploads
  shards. One learner, many actors.
  ```
  CZ_TOKEN=<github-pat> core/build/cz_pc                                   # learner (solo)
  CZ_BUS_URL=… CZ_BUS_TOKEN=<trainer> CZ_TOKEN=<pat> core/build/cz_pc      # learner + bus
  CZ_BUS_URL=… CZ_BUS_TOKEN=<worker>  core/build/cz_pc --actor             # actor (no GitHub token needed)
  ```
- **From a phone** — install the APK (GitHub Releases), open it, and on the **On-device actor** page paste
  the bus URL + a worker token and tap Start. It self-plays in the background (foreground service + wake-lock).

Notes:
- `CZ_TOKEN` is a GitHub PAT with **Contents: read+write**; `CZ_REPO` overrides the target (default
  `ghug/cribbage-zero`). Tunables (`CZ_WORKERS`, `CZ_SIMS`, `CZ_LR`, …) are documented in `pc/main.cpp`.
- **Multi-core:** the learner fans self-play across a `std::thread` pool (the main thread owns the net;
  N workers generate games). `CZ_WORKERS` defaults to cores − 1.
- **It won't throw out the cloud net.** It only starts fresh on a genuine 404 (no net yet) or explicit
  `--fresh`; a read error or a mismatched architecture makes it refuse to start.
- **Single learner:** the net is one force-pushed blob, so only one learner may train. The bus **lease**
  enforces this (a second learner refuses to start); Ctrl-C does a final push.

License: public domain (The Unlicense), matching the companion project.
