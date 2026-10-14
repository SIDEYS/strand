// Turns one results directory into the numbers: propagation latency by scope,
// memory per room (with a linearity check), per-interval behaviour as load
// rises, reconvergence after a kill, and whether the load generator itself was
// the bottleneck.
//
//   node loadtest/report.mjs loadtest/results/<run>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: report.mjs <results dir>');
  process.exit(2);
}
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const config = read('config.json');
const summary = read('summary.json');
const events = existsSync(join(dir, 'events.json')) ? read('events.json') : [];
const samples = readFileSync(join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const k6Log = existsSync(join(dir, 'k6.log')) ? readFileSync(join(dir, 'k6.log'), 'utf8') : '';
const start = Number(/K6_START (\d+)/.exec(k6Log)?.[1] ?? samples[0].t);
const bucketS = summary.config.BUCKET_S;

const M = summary.metrics;
const v = (name) => M[name]?.values;
const f = (n, d = 1) => (n === undefined || Number.isNaN(n) ? 'n/a' : Number(n).toFixed(d));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const out = [];
const line = (s = '') => out.push(s);

// ---- helpers over samples ------------------------------------------------------------------
const sockets = (s) => sum(s.instances.map((i) => i.m.strand_connected_sockets ?? 0));
const rooms = (s) => sum(s.instances.map((i) => i.m.strand_rooms_in_memory ?? 0));
const rss = (s) => sum(s.instances.map((i) => i.m.process_resident_memory_bytes ?? 0));
const answered = (s) => s.instances.filter((i) => i.ok).length;

function ols(points) {
  const n = points.length;
  const mx = sum(points.map((p) => p[0])) / n;
  const my = sum(points.map((p) => p[1])) / n;
  const sxx = sum(points.map((p) => (p[0] - mx) ** 2));
  const sxy = sum(points.map((p) => (p[0] - mx) * (p[1] - my)));
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const ssTot = sum(points.map((p) => (p[1] - my) ** 2));
  const ssRes = sum(points.map((p) => (p[1] - (intercept + slope * p[0])) ** 2));
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

function histogramPercentiles(name, qs) {
  // Cumulative buckets, summed across instances, last sample minus first.
  const bucketsOf = (s) => {
    const acc = new Map();
    for (const i of s.instances) {
      for (const [k, val] of Object.entries(i.m)) {
        const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`).exec(k);
        if (m) acc.set(m[1], (acc.get(m[1]) ?? 0) + val);
      }
    }
    return acc;
  };
  const first = bucketsOf(samples[0]);
  const last = bucketsOf(samples[samples.length - 1]);
  const rows = [...last.entries()]
    .map(([le, c]) => ({ le: le === '+Inf' ? Infinity : Number(le), c: c - (first.get(le) ?? 0) }))
    .sort((a, b) => a.le - b.le);
  const count = rows[rows.length - 1]?.c ?? 0;
  if (count === 0) return null;
  const result = { count };
  for (const q of qs) {
    const target = q * count;
    let prev = { le: 0, c: 0 };
    for (const row of rows) {
      if (row.c >= target) {
        const upper = Number.isFinite(row.le) ? row.le : prev.le;
        const span = row.c - prev.c;
        result[q] = span === 0 ? upper : prev.le + ((upper - prev.le) * (target - prev.c)) / span;
        break;
      }
      prev = row;
    }
  }
  return result;
}

const trendRow = (label, vals) =>
  vals && vals.count > 0
    ? `| ${label} | ${vals.count} | ${f(vals.med)} | ${f(vals['p(90)'])} | ${f(vals['p(95)'])} | ${f(vals['p(99)'])} | ${f(vals['p(99.9)'])} | ${f(vals.max)} |`
    : `| ${label} | 0 | | | | | | |`;

// ---- header -------------------------------------------------------------------------------
line(`# ${config.runId}`);
line();
line(`- scenario: **${config.scenario}**, ${config.vus} virtual users, ${config.roomSize} per room (${Math.ceil(config.vus / config.roomSize)} rooms), mode **${config.mode}**`);
line(`- ramp ${config.ramp}s, hold ${config.hold}s, drain ${config.drain}s, one edit per user about every ${config.editMs} ms (±50%), presence every ~5s`);
line(`- host: Docker ${config.host.docker}, ${config.host.cpus} CPUs, ${(Number(config.host.memBytes) / 2 ** 30).toFixed(1)} GiB shared by k6, 3 Strand instances, nginx, Redis, Postgres; code at ${config.gitCommit}`);
line(`- edits produced ${v('edits_sent')?.count}, deliveries ${v('edits_received')?.count} (${f(v('edits_received')?.rate, 0)}/s), sessions opened ${v('sessions_opened')?.count}`);
const verify = existsSync(join(dir, 'verify.txt')) ? readFileSync(join(dir, 'verify.txt'), 'utf8').trim().split('\n') : [];
line(`- integrity: ${verify.length ? verify.filter((l) => /INTEGRITY|lost|rooms read/.test(l)).join(' / ') : 'not checked'}`);
line();

// ---- host contention ------------------------------------------------------------------------------
{
  const others = samples.map((x) => x.host?.otherCpu).filter((x) => x !== undefined).sort((a, b) => a - b);
  if (others.length === 0) {
    line('> **Host contention was not recorded for this run** (it predates the recording), so latency tails here cannot be separated from other work on the machine.');
  } else {
    const med = others[Math.floor(others.length / 2)];
    const names = new Map();
    for (const x of samples) for (const p of x.host?.top ?? []) names.set(p.name, Math.max(names.get(p.name) ?? 0, p.cpu));
    const heavy = [...names].filter(([, c]) => c >= 20).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n} (up to ${f(c, 0)}%)`);
    const maxLoad = Math.max(...samples.map((x) => x.host?.load1 ?? 0));
    line(
      med > 100
        ? `> **The host was contended: other processes used a median ${f(med, 0)}% of a core (100% = one core), load average up to ${f(maxLoad)}${heavy.length ? `, mostly ${heavy.join(', ')}` : ''}. Latency tails and any breaking point in this run include that contention.**`
        : `> Host contention: other processes used a median ${f(med, 0)}% of a core (100% = one core), load average up to ${f(maxLoad)}${heavy.length ? `; heaviest: ${heavy.join(', ')}` : ''}.`,
    );
  }
  line();
}

// ---- propagation --------------------------------------------------------------------------
line('## End-to-end propagation latency (ms)');
line();
line('Time from a user generating an edit to another user receiving it, measured on one clock (all virtual users run in one k6 process), live deliveries only. The clock is `Date.now()`, so values are whole milliseconds: a reported 0 or 1 means "about a millisecond or less", and the sub-millisecond truth for the instance-to-instance hop is in the next section.');
line();
line('| scope | deliveries | p50 | p90 | p95 | p99 | p99.9 | max |');
line('|---|---|---|---|---|---|---|---|');
if (config.mode === 'direct') {
  line(trendRow('same instance', v('propagation_same_ms')));
  line(trendRow('different instance', v('propagation_cross_ms')));
} else {
  line(trendRow('all pairs (through nginx; scope unknown)', v('propagation_lb_ms')));
}
line();

// ---- fan-out as the servers saw it --------------------------------------------------------------
const fan = histogramPercentiles('strand_fanout_receive_seconds', [0.5, 0.95, 0.99]);
if (fan) {
  line('## Inter-instance hop as the servers measured it');
  line();
  line(`Publisher timestamp to receiver, for every envelope an instance received (n=${fan.count}): p50 ${f(fan[0.5] * 1000, 2)} ms, p95 ${f(fan[0.95] * 1000, 2)} ms, p99 ${f(fan[0.99] * 1000, 2)} ms (interpolated within Prometheus buckets, instances share one host clock).`);
  line();
}

// ---- memory per room ----------------------------------------------------------------------------
{
  // The sampler starts before k6, so the first sample is the idle baseline.
  const base = samples[0];
  const heap = (s) => sum(s.instances.map((i) => i.m.nodejs_heap_size_used_bytes ?? 0));
  const peakRooms = Math.max(...samples.map(rooms));
  const firstAtPeak = samples.findIndex((s) => rooms(s) === peakRooms);
  // Only the ramp: once rooms stop growing the x-values are all equal and a
  // regression says nothing about memory per room.
  const ramp = samples.slice(0, firstAtPeak + 1).filter((s) => answered(s) === 3 && rooms(s) > rooms(base));
  if (ramp.length >= 6) {
    line('## Memory per room');
    line();
    line(`A "room replica" is a room held in memory by one instance (a room with members on all three instances is three replicas; that is what \`strand_rooms_in_memory\` counts). Measured over the ramp, as growth above the idle baseline (${f(rss(base) / 2 ** 20)} MiB resident, ${f(heap(base) / 2 ** 20)} MiB heap, ${rooms(base)} replicas) across the three Strand processes. Resident memory is what the OS charges; heap-in-use is what the application holds, and is noisier because garbage is collected lazily.`);
    line();
    for (const [label, pick] of [['resident', rss], ['heap in use', heap]]) {
      const pts = ramp.map((s) => [rooms(s) - rooms(base), pick(s) - pick(base)]);
      const fit = ols(pts);
      const third = Math.max(Math.floor(pts.length / 3), 3);
      const lo = ols(pts.slice(0, third));
      const mid = ols(pts.slice(third, 2 * third));
      const hi = ols(pts.slice(-third));
      const peak = pts[pts.length - 1];
      line(`- ${label}: **${f(fit.slope / 1024, 1)} KiB per replica** (linear fit, ${pts.length} samples, R² ${f(fit.r2, 3)}); by thirds of the ramp ${f(lo.slope / 1024, 1)} / ${f(mid.slope / 1024, 1)} / ${f(hi.slope / 1024, 1)} KiB; at ${peak[0]} replicas ${f(peak[1] / 2 ** 20)} MiB above baseline = ${f(peak[1] / peak[0] / 1024, 1)} KiB each`);
    }
    line();
  }
}

// ---- per-interval table ----------------------------------------------------------------------------
line(`## Behaviour over time (${bucketS}s intervals from the start of the run)`);
line();
const prop = (b) => {
  const names = config.mode === 'direct' ? ['propagation_cross_ms', 'propagation_same_ms'] : ['propagation_lb_ms'];
  return names.map((n) => v(`${n}{bucket:${b}}`));
};
const header = config.mode === 'direct'
  ? '| t (s) | sockets | rooms | edits/s | cross p95 | cross p99 | cross max | same p95 | closes | conn fail | loop lag p99 (ms) | busiest instance CPU% | k6 CPU% | gen lag p95 (ms) |'
  : '| t (s) | sockets | rooms | edits/s | p50 | p95 | p99 | max | closes | conn fail | loop lag p99 (ms) | busiest instance CPU% | k6 CPU% | gen lag p95 (ms) |';
line(header);
line(header.replace(/[^|]/g, '-').replace(/-+/g, '---'));
const nb = Math.ceil((samples[samples.length - 1].t - start) / (bucketS * 1000));
for (let b = 0; b < nb; b++) {
  const from = start + b * bucketS * 1000;
  const inBucket = samples.filter((s) => s.t >= from && s.t < from + bucketS * 1000);
  if (inBucket.length === 0 && !prop(b)[0]) continue;
  const s = inBucket[inBucket.length - 1];
  const sent = v(`edits_sent{bucket:${b}}`)?.count ?? 0;
  const closes = v(`unexpected_closes{bucket:${b}}`)?.count ?? 0;
  const fails = v(`connect_failures{bucket:${b}}`)?.count ?? 0;
  const lag = inBucket.length ? Math.max(...inBucket.flatMap((x) => x.instances.map((i) => (i.m.nodejs_eventloop_lag_p99_seconds ?? 0) * 1000))) : undefined;
  const cpu = inBucket.length ? Math.max(...inBucket.flatMap((x) => Object.entries(x.docker).filter(([n]) => /strand-strand-/.test(n)).map(([, d]) => d.cpu))) : undefined;
  const k6cpu = inBucket.length ? Math.max(...inBucket.map((x) => x.docker['strand-k6']?.cpu ?? 0)) : undefined;
  const [a, c] = prop(b);
  if (config.mode === 'direct') {
    line(`| ${b * bucketS} | ${s ? sockets(s) : ''} | ${s ? rooms(s) : ''} | ${f(sent / bucketS, 0)} | ${f(a?.['p(95)'])} | ${f(a?.['p(99)'])} | ${f(a?.max)} | ${f(c?.['p(95)'])} | ${closes} | ${fails} | ${f(lag)} | ${f(cpu, 0)} | ${f(k6cpu, 0)} | ${f(v(`generator_lag_ms{bucket:${b}}`)?.['p(95)'])} |`);
  } else {
    line(`| ${b * bucketS} | ${s ? sockets(s) : ''} | ${s ? rooms(s) : ''} | ${f(sent / bucketS, 0)} | ${f(a?.med)} | ${f(a?.['p(95)'])} | ${f(a?.['p(99)'])} | ${f(a?.max)} | ${closes} | ${fails} | ${f(lag)} | ${f(cpu, 0)} | ${f(k6cpu, 0)} | ${f(v(`generator_lag_ms{bucket:${b}}`)?.['p(95)'])} |`);
  }
}
line();

// ---- server counters ------------------------------------------------------------------------------
{
  const last = samples[samples.length - 1];
  const first = samples[0];
  const delta = (name) => sum(last.instances.map((i) => i.m[name] ?? 0)) - sum(first.instances.map((i) => i.m[name] ?? 0));
  line('## Server counters over the run (summed across instances)');
  line();
  line(`- backpressure disconnects: **${delta('strand_backpressure_disconnects_total')}**`);
  const reasons = new Set(last.instances.flatMap((i) => Object.keys(i.m).filter((k) => k.startsWith('strand_disconnects_total{'))));
  for (const k of [...reasons].sort()) line(`- ${k}: ${delta(k)}`);
  const handshakes = new Set(last.instances.flatMap((i) => Object.keys(i.m).filter((k) => k.startsWith('strand_handshakes_total{'))));
  for (const k of [...handshakes].sort()) line(`- ${k}: ${delta(k)}`);
  line(`- doc updates accepted: ${delta('strand_doc_updates_total{origin="local"}')} local, ${delta('strand_doc_updates_total{origin="remote"}')} remote`);
  line(`- persistence: ops dropped ${delta('strand_persist_ops_dropped_total')}, flush failures ${delta('strand_persist_flush_failures_total')}, snapshot conflicts ${delta('strand_snapshot_conflicts_total')}`);
  const snap = histogramPercentiles('strand_snapshot_duration_seconds', [0.5, 0.99]);
  if (snap) line(`- snapshot duration (n=${snap.count}): p50 ${f(snap[0.5] * 1000, 1)} ms, p99 ${f(snap[0.99] * 1000, 1)} ms`);
  line();
}

// ---- load generator health ------------------------------------------------------------------------
{
  const k6 = samples.map((s) => s.docker['strand-k6']).filter(Boolean);
  const peakK6 = Math.max(0, ...k6.map((d) => d.cpu));
  const peakAll = Math.max(...samples.map((s) => sum(Object.values(s.docker).map((d) => d.cpu))));
  const capacity = 100 * Number(config.host.cpus);
  line('## Was the load generator, or the host, the bottleneck?');
  line();
  line(`Docker reports 100% per core and this host has ${config.host.cpus}, so capacity is ${capacity}%. k6 peaked at ${f(peakK6, 0)}%; all containers together peaked at ${f(peakAll, 0)}% (${f((100 * peakAll) / capacity, 0)}% of the host). ` +
    (peakAll > 0.85 * capacity
      ? '**The host was close to saturated: latency and the breaking point here include contention between the generator and the system under test.**'
      : 'The host had headroom, so what the table shows is the system, not contention with the generator.'));
  const lagBuckets = [];
  for (let b = 0; b < 400; b++) {
    const g = v(`generator_lag_ms{bucket:${b}}`);
    if (g && g.count > 0) lagBuckets.push([b, g['p(95)']]);
  }
  const late = lagBuckets.filter(([, p95]) => p95 > 50);
  const overall = v('generator_lag_ms');
  line(`Generator self-check: an edit's timer fires ${f(overall?.med, 0)} ms late at the median, ${f(overall?.['p(95)'], 0)} ms at p95, ${f(overall?.max, 0)} ms at worst. ` +
    (late.length === 0
      ? 'No interval had a p95 above 50 ms, so the generator kept up throughout.'
      : `**From ${late[0][0] * bucketS}s on, ${late.length} of ${lagBuckets.length} intervals had a timer-lateness p95 above 50 ms: the generator itself was overloaded there, so those intervals show its limit as much as the system's.**`));
  line();
}

// ---- reconvergence ---------------------------------------------------------------------------------
const killed = events.find((e) => /killing|freezing/.test(e.what));
if (killed) {
  const killedAt = killed.t;
  const rec = v('reconverge_ms');
  const frozen = config.failure === 'freeze';
  line(`## Instance ${frozen ? 'freeze' : 'kill'}`);
  line();
  line(
    frozen
      ? `${config.victim} was frozen (\`docker pause\`: process stopped, sockets stay open, no reset, no FIN) at +${f((killedAt - start) / 1000)}s while holding ${killed.victimSockets} of ${killed.socketsBefore} sockets. Clients can only find out by noticing silence.`
      : `${config.victim} was killed (SIGKILL) at +${f((killedAt - start) / 1000)}s while holding ${killed.victimSockets} of ${killed.socketsBefore} sockets. Peers receive a reset immediately, so this is the fastest-detected failure.`,
  );
  line();
  line('| metric | value |');
  line('|---|---|');
  line(`| connections that dropped (unexpected closes) | ${v('unexpected_closes')?.count} |`);
  line(`| reconnections completed (synced again) | ${rec?.count} |`);
  line(`| outage per client, loss to synced: p50 / p95 / p99 / max | ${f(rec?.med, 0)} / ${f(rec?.['p(95)'], 0)} / ${f(rec?.['p(99)'], 0)} / ${f(rec?.max, 0)} ms |`);
  line(`| failed connection attempts during recovery | ${v('connect_failures')?.count} |`);
  const after = samples.filter((s) => s.t > killedAt + 1000);
  const recovered = after.find((s) => sockets(s) >= 0.98 * config.vus);
  line(`| surviving instances' sockets back to ≥98% of ${config.vus} (5s sampling) | ${recovered ? `+${f((recovered.t - killedAt) / 1000)}s after the failure` : 'not within the run'} |`);
  line();
  line('The outage is each client\'s own: from the moment its connection was lost (for a frozen peer, the last frame it received) until it had reconnected, resumed its session, received the server\'s state and handed over any edit the dead connection swallowed. The maximum is when the last affected client was whole again. Reconnect delays follow the web client\'s real policy (500 ms base, equal jitter), so most of the floor here is deliberate backoff, not server time.');
  line();
}

const text = out.join('\n') + '\n';
writeFileSync(join(dir, 'report.md'), text);
console.log(text);
