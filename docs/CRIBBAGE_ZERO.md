# Cribbage Zero — self-play training

## Two modes (toggle in the app)

**1. On-device trainer (default).** One phone runs the whole AlphaZero loop locally — self-play → SGD
train → repeat — and pushes the net to GitHub for safekeeping. No Cloudflare, no servers, no rate limits.
- The APK page is `local.html` (the app's `index.html` routes to the saved mode).
- Net storage: on Start it resumes from whichever is newer (localStorage or GitHub); every N iters it
  **force-pushes an orphan commit** to a `net` branch (`checkpoints/az_checkpoint.json`) — so the branch
  always holds exactly one commit (latest net, zero history bloat). Pull it back from
  `https://raw.githubusercontent.com/<owner>/<repo>/net/checkpoints/az_checkpoint.json`.
- Needs a **fine-grained PAT with Contents: write** on the repo, pasted into the app (blank = train-only,
  no pushing). This is the simple path for 1–2 phones.

**2. Cloudflare worker (optional).** The distributed bus below — many phones/PCs push self-play to a
Cloudflare Worker + D1, and a scheduled GitHub Action trains. Use this only if you're fanning out across
many contributors; otherwise mode 1 is simpler. The rest of this doc covers mode 2.

---

## Cloudflare worker mode (distributed)

Workers (phone browsers, the APK, and PCs) generate self-play games and push them to a small
**Cloudflare Worker + D1** data-bus; a single **scheduled GitHub Action trainer** consumes them, trains
the net, and republishes the checkpoint. Workers pull the latest checkpoint to play against.

```
  worker.html / APK / node az_worker --remote        worker-api (Cloudflare Worker)        trainer
   - POST /shard  (self-play samples) ───────────────►  auth + CORS ──► D1 (SQLite)  ◄── GitHub Action (cron 30m):
   - GET  /checkpoint (latest net) ◄──────────────────                                  consume → train → publish → prune
```

Two bearer tokens: a **WORKER_TOKEN** handed to devices (may only append shards + read the checkpoint)
and a **TRAINER_TOKEN** for the trainer (may also consume/publish/prune). A leaked worker token can't
change anyone else's data.

---

## 1. One-time setup

### a. Cloudflare (the data-bus)
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

### b. GitHub (the trainer)
In `ghug/cribbage-zero` → Settings → Secrets and variables → Actions, add:
- `AZ_API_URL` = your Worker URL (e.g. `https://cribbage-zero-bus.<you>.workers.dev`)
- `AZ_TRAINER_TOKEN` = the **trainer** token

Enable Actions. The `Cribbage Zero trainer` workflow then runs every 30 min (or run it manually via
*Actions → Run workflow*). On an empty bus it seeds from `engine/az_seed.json` (continuing iter 1445).

---

## 2. Run workers

**Phone (browser or APK):** open `worker.html` (host it on Cloudflare Pages, or install the worker APK),
paste the **API URL** + your **WORKER_TOKEN**, set games/sims, tap **Start**. Watch *iterations pushed*.

**PC (uses all the speed of a real CPU):**
```bash
AZ_API_URL=https://cribbage-zero-bus.<you>.workers.dev \
AZ_WORKER_TOKEN=<worker token> \
node engine/az_worker.js 0 120 20 40 --remote      # id chunkBatches gamesPerBatch sims
```
Run several (one per core) with different ids; or many machines — all contention-free.

---

## 3. The trainer

Automatic via the GitHub Action. To run it yourself instead (or in addition — but keep it to **one**
trainer at a time, the single checkpoint writer):
```bash
AZ_API_URL=… AZ_TRAINER_TOKEN=<trainer token> \
node engine/az_trainer.js --remote --once --seed engine/az_seed.json
```
Drop `--once` to keep it polling.

---

## 4. Build & host the worker page

`worker.html` needs the engine bundle:
```bash
bash engine/build-bundle.sh        # -> worker/az_bundle.js (generated)
```
Then host `worker.html` + the `worker/` dir on any static host (Cloudflare Pages), or bundle them into
the worker APK (`android/`).

---

## 5. Security notes
- The **worker token** ships on every device but is least-privilege (append shards + read checkpoint).
  Still, rotate it periodically and keep the **trainer** token secret (GitHub secret only).
- Tokens are stored in the browser/app `localStorage` (plaintext, app-private). One token per fleet is
  fine; the trainer is the trust boundary.
- The Worker sets permissive CORS so any device can reach it with a token.

## 6. Local (single-machine) training — no network
```bash
node engine/az_parallel.js 4 120 20 40     # 4 workers + trainer on local files, all cores
node engine/az_net.js                      # core self-tests
```

## 7. Branches & releasing
**All work lands on `dev`; `main` is the release snapshot.** Day-to-day commits push to `dev` and do
**not** cut a release. Only on an explicit release request: merge `dev` → `main`, then publish a GitHub
Release with a `vX.Y.Z` tag — the `Worker APK Release` workflow builds + signs the APK. The scheduled
trainer and other Actions run from `main`, so changes go live only on release.

**Bump the patch number only** (`0.1.0 → 0.1.1 → …`); do **not** advance the minor or major version
unless explicitly asked. Bump `versionCode` by 1 and `versionName` to match in `android/app/build.gradle`,
using the **same** keystore.

## 8. Scaling & Cloudflare limits
Each game produces ~125 samples. Shards are **capped at 1500 samples** (~0.4 MB after the worker rounds
floats to 3 dp) to stay under D1's value-size limit (`SQLITE_TOOBIG`) — but **no samples are dropped**:
a batch is split across as many capped shards as needed and all are uploaded.

Request discipline (so the free tier stretches): the worker does **no periodic polling** — the trainer
`iter` rides back on each `POST /shard` response, and the net is re-fetched only when that iter advances.
Default upload cadence is the "Upload every (min)" field (5).

Free-tier budget (shared across **all** phones): **100k Worker requests/day** and **100k D1 row-writes/day**.
Each shard costs 1 request + 2 writes (insert + the trainer's prune) and holds ≤1500 samples. A phone at
max throughput produces **~1500–1700 samples/s (~140M samples/day)** — on its own roughly **2× the free
write budget**. So keeping every sample, the free tier comfortably suits about **one** full-time phone
(or a couple run intermittently / at fewer sims); a 24/7 max-throughput phone may hit the daily D1-write
cap (uploads then fail until the UTC reset — no charge). For sustained max-throughput or more phones,
either **subsample at the worker** or go **Cloudflare Workers Paid ($5/mo, ~50M writes/day)** — beyond
which the single GitHub-Action trainer is the bottleneck. The phone always out-produces one trainer, so
most self-play is inherently surplus regardless of tier.
