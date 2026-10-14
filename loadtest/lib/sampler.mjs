// Samples the servers from the outside while a load test runs: each instance's
// Prometheus endpoint (direct host ports, since the load balancer hides
// /metrics) and `docker stats` for every container, k6 included. The k6 numbers
// matter as much as the server's: a load generator that is out of CPU produces
// latency that belongs to the generator, and the report must be able to say so.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const KEEP = /^(strand_|process_resident_memory_bytes|process_cpu_seconds_total|nodejs_eventloop_lag|nodejs_heap_size_used_bytes)/;

/** Parses Prometheus text into { "name{labels sans instance}": value }. */
export function parseProm(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m || !KEEP.test(m[1])) continue;
    const labels = (m[2] ?? '').replace(/instance="[^"]*",?/, '').replace(/,\}/, '}').replace('{}', '');
    out[m[1] + labels] = Number(m[3]);
  }
  return out;
}

/** What else the machine is doing. On a laptop the load generator and the
 * system under test share CPUs with whatever the person is running, and a
 * benchmark that does not record that cannot be trusted. Percentages are
 * per-core (100 = one full core). The Docker VM itself is excluded: that is
 * our own load. */
export function hostBusy() {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-Ao', 'pcpu=,comm=', '-r']);
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.on('error', () => resolve({ load1: loadavg()[0], otherCpu: 0, top: [] }));
    child.on('close', () => {
      const procs = buf
        .split('\n')
        .map((l) => /^\s*([\d.]+)\s+(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ cpu: Number(m[1]), name: m[2].split('/').pop() }))
        .filter((p) => !/Virtualization|^ps$|^node$|^docker/.test(p.name));
      resolve({
        load1: loadavg()[0],
        otherCpu: procs.reduce((a, p) => a + p.cpu, 0),
        top: procs.slice(0, 3),
      });
    });
  });
}

function dockerStats() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.on('close', () => {
      const rows = {};
      for (const line of buf.split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          rows[r.Name] = { cpu: parseFloat(r.CPUPerc), mem: r.MemUsage.split('/')[0].trim() };
        } catch {
          // a container vanishing mid-sample is expected during a kill test
        }
      }
      resolve(rows);
    });
    child.on('error', () => resolve({}));
  });
}

export function startSampler({ file, ports, intervalMs = 5000 }) {
  writeFileSync(file, '');
  const t0 = Date.now();
  let stopped = false;
  let inFlight = Promise.resolve();

  const tick = async () => {
    // Stamp before the slow `docker stats` call, not after: the metrics are read at the start.
    const stamped = Date.now();
    const [docker, host, ...metrics] = await Promise.all([
      dockerStats(),
      hostBusy(),
      ...ports.map(async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(3000) });
          return { port, ok: true, m: parseProm(await res.text()) };
        } catch {
          return { port, ok: false, m: {} }; // down, or too busy to answer: both are findings
        }
      }),
    ]);
    appendFileSync(file, JSON.stringify({ t: stamped, since: stamped - t0, docker, host, instances: metrics }) + '\n');
  };

  const timer = setInterval(() => {
    if (!stopped) inFlight = inFlight.then(tick);
  }, intervalMs);
  inFlight = inFlight.then(tick);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}

/** Sum of a metric across the instances of one sample that answered. */
export function total(sample, name) {
  return sample.instances.reduce((sum, i) => sum + (i.m[name] ?? 0), 0);
}
