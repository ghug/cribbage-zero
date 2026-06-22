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
- `WORKER_TOKEN` → goes on **actors**. It can only `POST /shard`.
- `TRAINER_TOKEN` → goes on the **learner**. It can also `GET /shards` + `POST /prune`.
- Free tier: D1 storage stays bounded because the learner deletes consumed shards; shards are chunked
  small (≤ `CZ_SHARD_MAX` samples) to fit a D1 row.

Smoke-test the routes/auth without Cloudflare: `node worker-api/test.js`.

## 2. Run the learner (the always-on PC)

```bash
CZ_TOKEN=<github-pat> \
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<TRAINER_TOKEN> \
node engine/az_contribute.js
```
It self-plays, drains the actors' shards into the same replay buffer, trains, and pushes the net to GitHub
every `CZ_PUSH_GAMES` games (+ on Ctrl-C). Omit `CZ_BUS_*` to run solo (no bus).

## 3. Run actors (extra PCs / phones)

**PC actor** (no GitHub token needed — it reads the public net):
```bash
CZ_BUS_URL=https://cribbage-zero-bus.<you>.workers.dev \
CZ_BUS_TOKEN=<WORKER_TOKEN> \
node engine/az_contribute.js --actor
```

**Phone actor** — open **`worker.html`** (in the app: ⌂ → ⇄ Cloudflare worker mode). Paste the bus URL +
your `WORKER_TOKEN`, set the net repo (`ghug/cribbage-zero`), Start. It self-plays, uploads shards, and
re-pulls the net from GitHub whenever the learner advances it.

## Notes / limits
- **One learner only.** Two learners would force-push the net over each other. Extra machines must be `--actor`.
- The actor's net read is **anonymous** GitHub (public repo) — keep it polite (the page re-checks the tiny
  `info.json` at most every 5 min, refetching the multi-MB net only when the iter actually advances).
- Tune `CZ_BUS_LIMIT` (shards drained/round) and `CZ_SHARD_MAX` (samples/shard) if the queue grows; for a
  small fleet the always-on learner out-produces a phone, so the queue stays shallow.
