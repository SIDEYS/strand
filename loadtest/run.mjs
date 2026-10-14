// Orchestrates one load-test scenario against the running compose stack.
//
//   node loadtest/run.mjs <scenario> [--vus N] [--ramp S] [--hold S] [--edit-ms MS] [--kill-after S]
//
// Scenarios:
//   steady    500 sockets, round-robin direct to each instance, tagged same/cross instance
//   lb        the same load through nginx, to show what the load balancer adds
//   kill      500 sockets through nginx, kill one instance once all are connected
//   breaking  ramp far past 500 until something gives
//   rooms     3000 rooms of one user each, barely typing: what does a room cost?
//
// Everything lands in loadtest/results/<scenario>-<time>/ (gitignored), then
// report.mjs turns it into numbers. Nothing here is estimated.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostBusy, startSampler } from './lib/sampler.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const presets = {
  steady: { vus: 500, ramp: 60, hold: 120, mode: 'direct' },
  lb: { vus: 500, ramp: 60, hold: 120, mode: 'lb' },
  kill: { vus: 500, ramp: 60, hold: 150, mode: 'lb' },
  breaking: { vus: 3000, ramp: 300, hold: 60, mode: 'lb' },
  // One user per room and almost no typing: isolates what a room costs from what its content costs.
  rooms: { vus: 3000, ramp: 300, hold: 30, mode: 'direct', roomSize: 1, editMs: 10000 },
};
const preset = presets[scenario];
if (!preset) {
  console.error(`scenario must be one of: ${Object.keys(presets).join(', ')}`);
  process.exit(2);
}
const vus = Number(arg('vus', preset.vus));
const ramp = Number(arg('ramp', preset.ramp));
const hold = Number(arg('hold', preset.hold));
const drain = Number(arg('drain', 15));
const editMs = Number(arg('edit-ms', preset.editMs ?? 1000));
const roomSize = Number(arg('room-size', preset.roomSize ?? 5));
const mode = arg('mode', preset.mode);
const killAfter = Number(arg('kill-after', 20)); // seconds after every socket is connected
const victim = arg('victim', 'strand-2');
// Cap the generator so it cannot starve the system under test of CPU; if it is
// the first thing to saturate, the report says so (generator_lag_ms).
const k6Cpus = arg('k6-cpus', '5');
const restartAfter = Number(arg('restart-after', 60));
const failure = arg('failure', 'kill'); // kill: SIGKILL (peers get a reset); freeze: pause the container (peers get silence)

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runId = `${scenario}-${stamp}`.toLowerCase();
const dir = join(root, 'loadtest', 'results', runId);
mkdirSync(dir, { recursive: true });
const events = [];
const note = (what, extra = {}) => {
  const e = { t: Date.now(), what, ...extra };
  events.push(e);
  console.log(`[${new Date(e.t).toISOString().slice(11, 19)}] ${what}`);
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2));
};
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });

// A benchmark on a machine that is busy with something else measures the
// machine. Look before starting, and refuse unless told to go ahead anyway.
const hostBefore = [];
for (let i = 0; i < 3; i++) {
  hostBefore.push(await hostBusy());
  await new Promise((r) => setTimeout(r, 2000));
}
const otherCpu = hostBefore.map((h) => h.otherCpu).sort((a, b) => a - b)[1];
if (otherCpu > 100 && !process.argv.includes('--allow-busy')) {
  console.error(
    `refusing to run: other processes on this machine are using ${otherCpu.toFixed(0)}% of a core ` +
      `(100% = one core), load average ${hostBefore[2].load1.toFixed(1)}. Heaviest: ` +
      hostBefore[2].top.map((p) => `${p.name} ${p.cpu}%`).join(', ') +
      '.\nClose them and retry, or pass --allow-busy to run anyway (the report will say the host was contended).',
  );
  process.exit(3);
}

if (!(await fetch('http://localhost:8080/readyz').then((r) => r.ok).catch(() => false))) {
  console.error('the stack is not up: run `docker compose up -d --build --wait` first');
  process.exit(1);
}

writeFileSync(
  join(dir, 'config.json'),
  JSON.stringify(
    {
      scenario, runId, vus, ramp, hold, drain, editMs, roomSize, mode, victim, k6Cpus,
      killAfter: scenario === 'kill' ? killAfter : null,
      failure: scenario === 'kill' ? failure : null,
      host: { docker: sh('docker', ['version', '--format', '{{.Server.Version}}']).stdout.trim(), cpus: sh('docker', ['info', '--format', '{{.NCPU}}']).stdout.trim(), memBytes: sh('docker', ['info', '--format', '{{.MemTotal}}']).stdout.trim() },
      gitCommit: sh('git', ['rev-parse', '--short', 'HEAD']).stdout.trim(),
      hostBefore: { otherCpu, load1: hostBefore[2].load1, top: hostBefore[2].top },
    },
    null,
    2,
  ),
);

const ports = [8081, 8082, 8083];
const stopSampler = startSampler({ file: join(dir, 'samples.jsonl'), ports, intervalMs: 5000 });

note('starting k6', { vus, ramp, hold, mode });
const k6 = spawn(
  'docker',
  [
    'run', '--rm', '--name', 'strand-k6', '--network', 'strand_default', '--cpus', k6Cpus,
    '-v', `${join(root, 'loadtest')}:/loadtest`,
    '-e', `MODE=${mode}`, '-e', `VUS=${vus}`, '-e', `ROOM_SIZE=${roomSize}`, '-e', `RAMP_S=${ramp}`,
    '-e', `HOLD_S=${hold}`, '-e', `DRAIN_S=${drain}`, '-e', `EDIT_MS=${editMs}`, '-e', `RUN_ID=${runId}`,
    '-e', `SUMMARY_FILE=/loadtest/results/${runId}/summary.json`,
    'grafana/k6', 'run', '--quiet', '/loadtest/collab.k6.js',
  ],
  { cwd: root },
);
const k6Log = join(dir, 'k6.log');
k6.stdout.on('data', (d) => appendFileSync(k6Log, d));
k6.stderr.on('data', (d) => appendFileSync(k6Log, d));
const k6Done = new Promise((r) => k6.on('close', r));

// Kill scenario: wait until every socket is up, hold, then kill the victim.
if (scenario === 'kill') {
  const sockets = async () => {
    let n = 0;
    for (const port of ports) {
      try {
        const text = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2000) }).then((r) => r.text());
        n += Number(/^strand_connected_sockets\S* (\S+)/m.exec(text)?.[1] ?? 0);
      } catch {
        // an instance that is already down contributes nothing
      }
    }
    return n;
  };
  const killer = (async () => {
    while ((await sockets()) < vus * 0.98) await new Promise((r) => setTimeout(r, 1000));
    note('all sockets connected', { sockets: await sockets() });
    await new Promise((r) => setTimeout(r, killAfter * 1000));
    const victimPort = ports[Number(victim.slice(-1)) - 1];
    const heldByVictim = Number(/^strand_connected_sockets\S* (\S+)/m.exec(await fetch(`http://127.0.0.1:${victimPort}/metrics`).then((r) => r.text()))?.[1] ?? 0);
    note(failure === 'freeze' ? `freezing ${victim} (docker pause)` : `killing ${victim} (SIGKILL)`, { victimSockets: heldByVictim, socketsBefore: await sockets() });
    sh('docker', ['compose', failure === 'freeze' ? 'pause' : 'kill', victim]);
    note(`${victim} ${failure === 'freeze' ? 'frozen' : 'killed'}`);
    await new Promise((r) => setTimeout(r, restartAfter * 1000));
    sh('docker', ['compose', failure === 'freeze' ? 'unpause' : 'start', victim]);
    note(`${victim} ${failure === 'freeze' ? 'unfrozen' : 'started again'}`);
  })();
  await Promise.race([killer, k6Done]);
}

await k6Done;
note('k6 finished');
if (scenario === 'kill') {
  sh('docker', ['compose', 'unpause', victim]); // in case k6 ended first
  sh('docker', ['compose', 'start', victim]);
}
await new Promise((r) => setTimeout(r, 12000)); // let the last samples show the drained state
await stopSampler();

const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const sent = summary.metrics.edits_sent?.values.count ?? 0;
note('verifying integrity', { editsSent: sent });
const v = spawnSync('node', ['loadtest/verify.mjs', '--run', runId, '--vus', String(vus), '--room-size', String(roomSize), '--expect', String(sent)], { cwd: root, encoding: 'utf8' });
writeFileSync(join(dir, 'verify.txt'), v.stdout + v.stderr);
console.log(v.stdout);
note(v.status === 0 ? 'integrity ok' : 'integrity FAILED');
console.log(`results: ${dir}`);
process.exit(0);
