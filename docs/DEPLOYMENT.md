# Deploying Strand

Three or more identical instances behind a load balancer, with managed Redis and
managed Postgres. This guide uses Fly.io because it provides all four pieces
(machines, a proxy that load-balances WebSockets, managed Postgres, managed
Redis) with a CLI. The commands are written out so you can run them yourself;
**nothing here has been executed against a real account**. The Fly commands and
flags come from Fly's CLI reference as of October 2026, so check `fly <command> --help`
if one has changed.

What the platform must provide is small, and is the same on any cloud:

| Requirement | Why |
|---|---|
| 3+ instances of the same image, sharing `REDIS_URL`, `DATABASE_URL`, `RESUME_SECRET` | Fan-out, presence and session leases live in Redis; documents in Postgres; a resume token minted by one instance must verify on another |
| Plain round-robin (or any non-sticky) balancing | Nothing depends on a client returning to the same instance. Do not enable stickiness; it would hide bugs, not fix any |
| WebSocket upgrade support and an idle timeout comfortably above `HEARTBEAT_INTERVAL_MS` (15 s) | The server pings at that interval; a proxy that drops idle connections at 60 s is fine, one that drops them at 10 s is not |
| Health check on `/readyz` | Takes an instance out of rotation for new connections when it loses a dependency, without dropping its existing sockets (`/healthz` is for "restart me", see below) |
| Migrations run once per deploy, not once per instance | See `release_command` in [fly.toml](../fly.toml) |

## Commands (Fly.io)

```bash
# 0. One-time: install flyctl and sign in.
fly auth login

# 1. Create the app. Names are global: pick your own and put it in fly.toml too.
fly apps create strand-yourname

# 2. Managed Postgres. The attach step stores DATABASE_URL as an app secret.
fly mpg create --name strand-db --region iad --plan Basic
fly mpg list                                      # copy the cluster ID
fly mpg attach <CLUSTER_ID> --app strand-yourname

# 3. Managed Redis (Upstash). The command prompts for org and region.
fly redis create
fly redis status <redis-name>                     # copy the Private URL

# 4. Secrets. RESUME_SECRET signs resume tokens and must be identical on every
#    instance; generate it here and do not reuse the compose default.
fly secrets set --app strand-yourname \
  REDIS_URL='<private url from step 3>' \
  RESUME_SECRET="$(openssl rand -base64 32)"

# 5. Deploy. The release command applies migrations first, once.
fly deploy --app strand-yourname

# 6. Three instances (fly deploy starts one or two on its own).
fly scale count 3 --region iad --app strand-yourname
fly status --app strand-yourname                  # all machines should be "started" and passing checks

# 7. Verify the deployment.
curl -fsS https://strand-yourname.fly.dev/readyz  # {"status":"ready", ...}
node loadtest/smoke.mjs https://strand-yourname.fly.dev
```

Step 7's smoke test connects two clients and keeps going until they land on
**different** instances (it prints which), then checks that an edit crosses in
both directions and the two copies converge. If it passes, fan-out through
Redis works on your platform. Then open the URL in two browser windows, edit
in both, switch one to offline in dev tools, edit, reconnect, and watch the text
merge.

### Things to check that I could not

- **Redis compatibility.** Strand needs pub/sub, Lua scripting (`EVAL`) and the
  Redis `TIME` command inside scripts (presence timestamps and session leases).
  Redis proper supports all of that and the compose stack and the test suite
  run against it. I have not run Strand against Upstash. The smoke test above
  exercises fan-out, but only a full session (presence, reconnect with a token)
  proves the Lua paths, so do both before trusting it.
- **Postgres TLS.** The connection string `fly mpg attach` writes is passed to
  `pg` as is. If your cluster requires TLS and the string lacks `sslmode`,
  append `?sslmode=require`.
- **Redis TLS.** The Private URL Fly prints is `redis://` over Fly's private
  network. If you use a provider that gives you `rediss://`, ioredis handles it
  with no code change.

## Operating it

- **`/healthz` and `/readyz`.** `/healthz` answers 200 whenever the process
  can answer at all, and nothing else. It means "this process is alive", so
  restart it if it stops answering. `/readyz` checks Redis and Postgres (each
  probe time-bounded and cached for a second) and returns 503 when either is
  down. It means "do not send this instance new connections". During a Redis
  outage every instance returns 503 from `/readyz` but stays up and keeps
  serving the sockets it has, so collaborators connected to the same instance
  keep editing together while cross-instance sync pauses and then catches up
  on its own when Redis returns (reconciliation, ADR 0002). Wire the platform's
  **restart** logic to `/healthz` and its **routing** logic to `/readyz`; the
  other way around turns a dependency blip into a restart storm.
- **Metrics.** `/metrics` is Prometheus text, one registry per instance, with
  an `instance` label. Strand does not authenticate it, so do not expose it
  through the public proxy (the nginx config in `deploy/nginx.conf` returns 404
  for it). On Fly, scrape it over the private network or add a `[metrics]`
  section to `fly.toml` pointing at a separate internal port.
- **Rolling deploys.** `fly deploy` replaces machines one at a time. Each
  replaced machine drops its sockets; clients reconnect with their resume token
  to another instance (typically well under a second; a few seconds at the tail
  when the proxy has to discover a dead machine, see the benchmark numbers). Expect a brief reconnect wave per machine.
- **Secrets rotation.** Changing `RESUME_SECRET` invalidates every outstanding
  resume token; clients fall back to a fresh join (they lose nothing but the
  seamless-resume fast path). Rotate during a deploy, not during an incident.
- **Scaling.** One instance is one Node.js process, so one core. The load test
  in the README shows how many sockets and edits per second that handles on the
  hardware it was run on. Add instances, not bigger instances.

## What this setup does not give you

- Multi-region fan-out. Redis pub/sub across regions is a latency and
  consistency decision this project has not made; keep Redis and the instances
  in one region.
- Redis high availability beyond what your provider supplies. A Redis failover
  looks to Strand like a short outage (see above), which it tolerates, but
  Strand does not itself replicate Redis.
