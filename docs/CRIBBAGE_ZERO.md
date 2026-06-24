# Cribbage Zero — distributed self-play training

One **learner** (a PC running the native C++ `cz_pc`) trains the net; many **actors** (PCs and phones)
generate self-play and feed it through a Cloudflare **data bus**. The trained net lives on the GitHub
`net` branch. This doc is the end-to-end setup; `docs/BUS.md` is the quick bus walkthrough.

> The old in-browser/Node trainers (`local.html` "on-device trainer", `engine/az_*.js` CLIs, the scheduled
> GitHub-Action trainer) are **retired**. The engine is now a single C++ binary, `cz_pc`. The browser is
> observer/controller only (monitor, eval, progress, and the Android actor's controls).

```
  actors (PC: cz_pc --actor · Android: native service)      worker-api (Cloudflare Worker + D1)     learner (one PC)
   - POST /shard  (self-play samples) ──────────────────►  auth + CORS ──► D1 (shard queue)  ◄── cz_pc:
   - GET net (GitHub raw) ◄─────────────────────────────                                         drain → train → push net → prune
```

Two bearer tokens: a **WORKER_TOKEN** for actors (may `POST /shard`, read the queue depth + learner status)
and a **TRAINER_TOKEN** for the learner (may also drain/prune and hold the single-writer **lease**). A leaked
worker token can't read or wipe the queue.

---

## 1. One-time setup

### a. Cloudflare (the data bus)
Needs a (free) Cloudflare account + `npm i -g wrangler` (not on Android/Termux — use a real machine).

```bash
cd worker-api
wrangler login
wrangler d1 create cribbage-zero                 # paste the printed database_id into wrangler.toml
wrangler d1 execute cribbage-zero --remote --file schema.sql

# pick two strong random tokens (keep them safe):
WORKER_TOKEN=$(openssl rand -hex 24);  TRAINER_TOKEN=$(openssl rand -hex 24)
echo "worker:  $WORKER_TOKEN" ; echo "trainer: $TRAINER_TOKEN"
printf '%s' "$WORKER_TOKEN"  | wrangler secret put WORKER_TOKEN
printf '%s' "$TRAINER_TOKEN" | wrangler secret put TRAINER_TOKEN

wrangler deploy                                  # -> https://cribbage-zero-bus.<you>.workers.dev
```
Smoke-test the routes/auth without Cloudflare first: `node worker-api/test.js`.

### b. The learner
The learner is the C++ `cz_pc` binary run on an always-on PC (no GitHub-Action trainer any more). It needs a
GitHub PAT (Contents: read+write) to push the net, plus the bus URL + **TRAINER_TOKEN**. See [§3](#3-the-learner).

---

## 2. Run actors

**PC** (no GitHub token needed — it reads the public net):
```bash
cmake -B core/build -S core && cmake --build core/build -j     # build cz_pc once (needs libcurl)
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<worker token> \
core/build/cz_pc --actor
```
Run on as many machines as you like — contention-free; each fans across its own cores.

**Phone** — install the APK (GitHub Releases), open it, go to **On-device actor** (`actor.html`), paste the
bus URL + your **WORKER_TOKEN**, set sims/threads + a net-refresh throttle, tap **Start**. It self-plays in
the background via a native foreground service (wake-lock + notification) and shows a live readout. The
`worker.html` page is a **read-only monitor** (net progress, queue depth, learner status), not an actor.

---

## 3. The learner

One always-on PC runs `cz_pc` (the single net-writer; it takes the bus lease so a second learner refuses to start):
```bash
cmake -B core/build -S core && cmake --build core/build -j
CZ_TOKEN=<github-pat> \
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<trainer token> \
core/build/cz_pc
```
It self-plays, drains the bus, trains a bounded replay buffer, and force-pushes the net to the `net` branch
every `CZ_PUSH_GAMES` games (+ on Ctrl-C). Omit `CZ_BUS_*` to run solo. Tunables (`CZ_WORKERS`, `CZ_SIMS`,
`CZ_LR`, `CZ_MOMENTUM`, …) are in `pc/main.cpp`; the math/recipe notes are in `README` + the code.

---

## 4. The browser bundle (eval only)

`eval.html` runs the net in the browser to measure strength, so it needs the JS engine bundle:
```bash
bash engine/build-bundle.sh        # -> worker/az_bundle.js (generated, git-ignored)
```
This is the **only** remaining in-browser use of the JS engine — actors are native (`cz_pc` / the Android
NDK service), so they don't need it. The Pages workflow and the APK build run `build-bundle.sh` automatically.

---

## 5. Security notes
- The **worker token** ships on every device but is least-privilege (append shards; read queue depth +
  learner status). Rotate it periodically; keep the **trainer** token secret.
- Tokens are stored in the browser/app `localStorage` (plaintext, app-private) or passed as env vars to
  `cz_pc`. The trainer token is the trust boundary.
- The Worker sets permissive CORS so any device can reach it with a token.

## 6. Local (single-machine) — no network
```bash
core/build/cz_pc --dry        # multi-core local self-play bench (add --fresh to start fresh)
ctest --test-dir core/build   # C++ core self-tests (scoring, net gradient check, MCTS, self-play, actor loop)
```

## 7. Branches & releasing
**All work lands on `dev`; `main` is the release snapshot.** Versioning mirrors `cribbage-trainer`: on
`dev`, `version.js` is `<next-patch>-dev.<n>` — the first commit after release `X.Y.Z` is `X.Y.(Z+1)-dev.1`,
and **every code-changing commit bumps `-dev.<n>`** (docs-only commits don't). A release drops the `-dev.<n>`
suffix, bumps the patch + `android/app/build.gradle` `versionCode`/`versionName`, then pushes `dev` + `main`
and tags `vX.Y.Z` — the `Worker APK Release` workflow builds + signs the APK and the `Snapshot the net`
workflow archives the net. **Bump the patch only** unless explicitly asked. GitHub Pages publishes the
observer pages from `dev`; Cloudflare serves the repo root.

## 8. Scaling & Cloudflare limits
Each game produces ~125 samples. Shards are **capped at `CZ_SHARD_MAX` (1500) samples** (~0.4 MB after the
client rounds floats to 3 dp) to stay under D1's value-size limit (`SQLITE_TOOBIG`) — but **no samples are
dropped**: a batch splits across as many capped shards as needed.

Free-tier budget (shared across all actors): **100k Worker requests/day** and **100k D1 row-writes/day**.
Each shard costs 1 request + 2 writes (insert + the learner's prune). A phone at max throughput produces
~1500–1700 samples/s — on its own roughly 2× the free write budget. So the free tier comfortably suits about
**one** full-time phone (or a couple run intermittently / at fewer sims); a 24/7 max-throughput phone may hit
the daily D1-write cap (uploads fail until the UTC reset — no charge). For more, **subsample at the worker**
or go **Cloudflare Workers Paid ($5/mo, ~50M writes/day)**. The actors out-produce one learner, so most
self-play is inherently surplus regardless of tier — the learner's own self-play already saturates it; bus
contributions are a bonus, and the net-refresh throttle on actors bounds their net re-download data.
