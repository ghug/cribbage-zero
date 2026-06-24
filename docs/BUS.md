# Cribbage Zero — distributed self-play (Cloudflare data bus)

Run self-play on several devices at once. The **net stays on GitHub** (single writer); the bus is only a
**queue of self-play sample shards** that the actors fill and the one learner drains.

```
 actors (phones/PCs): self-play ──POST /shard──►  Cloudflare Worker ──► D1 (shards queue)
        ▲ pull net (GitHub raw)                          ▲ GET /shards + POST /prune
        │                                                │
 learner (one PC): self-play + drain bus → train → push net ──► GitHub `net` branch ──► everyone pulls
```

**Roles, not machines.** Many **actors**; exactly **one learner** (the only net-writer). The learner is
*also* an actor — its own self-play goes straight into its replay buffer.

## 1. Deploy the Worker (one time, on your Cloudflare account)

```bash
cd worker-api
npm i -g wrangler            # if needed  (NB: wrangler can't run on bare Android/Termux — use a PC)
wrangler login
wrangler d1 create cribbage-zero            # paste the printed database_id into wrangler.toml
wrangler d1 execute cribbage-zero --remote --file schema.sql
wrangler secret put WORKER_TOKEN            # actor token  (paste a long random string)
wrangler secret put TRAINER_TOKEN           # learner token (a DIFFERENT long random string)
wrangler deploy                             # -> https://cribbage-zero-bus.<you>.workers.dev
```
- `WORKER_TOKEN` → goes on **actors**. It can `POST /shard` and read the queue depth + learner status
  (`GET /stats`, `GET /lease`).
- `TRAINER_TOKEN` → goes on the **learner**. It can also `GET /shards` + `POST /prune` and hold the lease.
- Free tier: D1 storage stays bounded because the learner deletes consumed shards; shards are chunked
  small (≤ `CZ_SHARD_MAX` samples) to fit a D1 row.

Smoke-test the routes/auth without Cloudflare: `node worker-api/test.js`.

## 2. Run the learner (the always-on PC)

```bash
cmake -B core/build -S core && cmake --build core/build -j    # build cz_pc once (needs libcurl)
CZ_TOKEN=<github-pat> \
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<TRAINER_TOKEN> \
core/build/cz_pc
```
The C++ `cz_pc` learner self-plays, drains the actors' shards into the same replay buffer, trains, and
pushes the net to GitHub every `CZ_PUSH_GAMES` games (+ on Ctrl-C). Omit `CZ_BUS_*` to run solo (no bus).
With a bus it also takes a **single-writer lease** so a second learner refuses to start.

## 3. Run actors (extra PCs / phones)

**PC actor** (no GitHub token needed — it reads the public net):
```bash
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<WORKER_TOKEN> \
core/build/cz_pc --actor
```

**Phone actor** — install the APK (GitHub Releases) and open the **On-device actor** page (`actor.html`,
in the app: ⌂ → On-device actor). Paste the bus URL + your `WORKER_TOKEN`, set sims/threads + a net-refresh
throttle, **Start**. The native engine self-plays in the background (foreground service + wake-lock + a live
readout), uploads shards, and re-pulls the net when the learner advances it. (`worker.html` is the read-only
**monitor**, not an actor.)

## Notes / limits
- **One learner only.** Two learners would force-push the net over each other (the bus lease enforces it).
  Extra machines must be `--actor`.
- The actor's net read is **anonymous** GitHub (public repo). It probes the tiny `info.json` once a round
  and only re-downloads the multi-MB net when the iter advances — throttled to at most once per the actor's
  **Refresh net (min)** setting, to bound data use.
- Tune `CZ_BUS_LIMIT` (shards drained/round) and `CZ_SHARD_MAX` (samples/shard) if the queue grows; for a
  small fleet the always-on learner out-produces a phone, so the queue stays shallow.
