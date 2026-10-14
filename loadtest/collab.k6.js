// Strand load test: N simulated collaborators typing into shared rooms.
//
// Run through ./run.mjs, which supplies the environment, samples the servers and
// checks the result. Run directly only to experiment:
//
//   docker run --rm --network strand_default -v "$PWD/loadtest:/loadtest" \
//     -e MODE=direct -e VUS=60 grafana/k6 run /loadtest/collab.k6.js
//
// What one virtual user does: join a room, announce presence, type a small
// tagged edit about once a second, receive everyone else's edits, and keep
// doing that until the test ends. If its socket dies it reconnects with its
// resume token, exactly as the web client does, and hands over any edits the
// server never received. Every edit carries "@sentAt:vu:seq:instance@", so
// whoever receives it can compute end-to-end propagation latency and know
// whether sender and receiver shared an instance.
//
// MODE=direct connects to each instance itself, round-robin. That is the only
// way to know which instance a socket landed on (k6 exposes the upgrade
// response's headers only after the socket closes), and so the only way to
// separate same-instance from cross-instance latency. MODE=lb goes through
// nginx, which is what production traffic looks like, but cannot tag by scope.
import { WebSocket } from 'k6/websockets';
import { Counter, Trend } from 'k6/metrics';
import {
  Typist,
  extractMarkers,
  frameDocUpdate,
  frameHello,
  framePong,
  framePresence,
  frameSyncStep1,
  marker,
  parseFrame,
} from './lib/frames.mjs';

const env = (name, fallback) => (__ENV[name] !== undefined && __ENV[name] !== '' ? __ENV[name] : fallback);
const VUS = Number(env('VUS', 60));
const ROOM_SIZE = Number(env('ROOM_SIZE', 5));
const RAMP_S = Number(env('RAMP_S', 30));
const HOLD_S = Number(env('HOLD_S', 60));
const DRAIN_S = Number(env('DRAIN_S', 10));
const EDIT_MS = Number(env('EDIT_MS', 1000));
const MODE = env('MODE', 'direct');
const RUN = env('RUN_ID', 'run');
const INSTANCES = env('INSTANCES', 'strand-1:8080,strand-2:8080,strand-3:8080').split(',');
const LB = env('LB', 'lb:80');
const OUT = env('SUMMARY_FILE', '/loadtest/results/summary.json');
const BUCKET_S = 10;

const propagationSame = new Trend('propagation_same_ms', true);
const propagationCross = new Trend('propagation_cross_ms', true);
const propagationLb = new Trend('propagation_lb_ms', true);
const reconverge = new Trend('reconverge_ms', true);
const joinTime = new Trend('join_ms', true);
const editsSent = new Counter('edits_sent');
const editsReceived = new Counter('edits_received');
const sessions = new Counter('sessions_opened');
const unexpectedCloses = new Counter('unexpected_closes');
const connectFailures = new Counter('connect_failures');
const unknownFrames = new Counter('unknown_frames');
const generatorLag = new Trend('generator_lag_ms', true);
const silentDeaths = new Counter('silent_deaths');
const handshakeTimeouts = new Counter('handshake_timeouts');

const totalS = RAMP_S + HOLD_S + DRAIN_S;
const buckets = Math.ceil(totalS / BUCKET_S) + 1;

// Per-bucket series are how the report shows degradation over time: k6 only
// keeps tagged sub-metrics in its summary when a threshold names them, so
// these trivially-true thresholds exist purely to make k6 keep them.
const thresholds = {};
for (let b = 0; b < buckets; b++) {
  for (const name of ['propagation_same_ms', 'propagation_cross_ms', 'propagation_lb_ms', 'reconverge_ms', 'generator_lag_ms']) {
    thresholds[`${name}{bucket:${b}}`] = ['max>=0'];
  }
  for (const name of ['edits_sent', 'edits_received', 'unexpected_closes', 'connect_failures']) {
    thresholds[`${name}{bucket:${b}}`] = ['count>=0'];
  }
}

export const options = {
  scenarios: {
    users: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${totalS + 120}s`,
    },
  },
  thresholds,
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max', 'avg', 'count'],
  discardResponseBodies: true,
};

export function setup() {
  const start = Date.now();
  // The report aligns its time buckets with the server samples using this.
  console.log(`K6_START ${start}`);
  return { start };
}

const jitter = (low, high) => low + Math.random() * (high - low);

/** The web client's reconnect policy (src/protocol/reconnect.ts): exponential
 * from 500 ms capped at 30 s, with "equal jitter" (half fixed, half random). */
function backoffMs(failures) {
  const ceiling = Math.min(30000, 500 * 2 ** Math.min(Math.max(failures - 1, 0), 30));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** How long the web client tolerates silence before declaring the socket dead. */
const silenceLimitMs = (heartbeatMs) => Math.ceil(heartbeatMs * 1.5) + 1000;

function parseInstance(name) {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
}

const HANDSHAKE_TIMEOUT_MS = 8000; // the web client's default

const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function (data) {
  const vu = __VU;
  const room = `${RUN}-${Math.floor((vu - 1) / ROOM_SIZE)}`;
  const startAt = data.start + ((vu - 1) / VUS) * RAMP_S * 1000;
  const stopTypingAt = data.start + (RAMP_S + HOLD_S) * 1000;
  const endAt = data.start + totalS * 1000;
  const bucketOf = (t) => String(Math.floor((t - data.start) / (BUCKET_S * 1000)));

  const wait = startAt - Date.now();
  if (wait > 0) await nap(wait);

  const typist = new Typist(100000 + vu);
  let seq = 0;
  let token = null;
  let instance = (vu - 1) % INSTANCES.length; // direct mode: round-robin placement
  let lostAt = 0; // when the current outage began, 0 when connected
  let failures = 0;

  /** One connection, from dial to close. Resolves with whether it ever got as far as a WELCOME. */
  const session = () =>
    new Promise((resolve) => {
      const target = MODE === 'lb' ? LB : INSTANCES[instance];
      const myInstance = MODE === 'lb' ? 0 : instance + 1;
      const connectStarted = Date.now();
      let handshakeTimer;
      let finished = false; // the test ended; closing is expected
      let over = false; // this session is done, whatever the socket is still doing
      let welcomed = false;
      let synced = false;
      let lastHeard = connectStarted;
      let heartbeatMs = 0;

      const ws = new WebSocket(`ws://${target}/ws`);
      ws.binaryType = 'arraybuffer';
      const send = (frame) => {
        if (!over && ws.readyState === 1) ws.send(frame.buffer);
      };
      // Timers are never cancelled one by one: every callback checks `over`.
      const after = (fn, ms) => setTimeout(fn, ms);
      const finish = () => {
        if (over) return;
        over = true;
        clearTimeout(handshakeTimer);
        resolve(welcomed);
      };
      // Closing a socket whose peer is frozen can wait forever for the
      // peer's half of the handshake, so give up on it like the web client
      // does: abandon it and move on.
      const abandon = () => {
        try {
          ws.close();
        } catch (e) {
          // already closing
        }
        after(finish, 500);
      };

      ws.onopen = () => {
        sessions.add(1);
        send(frameHello(room, token));

        // Typing: a small tagged edit at a jittered interval.
        // How late each scheduled edit fires is the generator's own health
        // check: if timers are late, this process is too busy to be trusted as
        // a source of load or a measurer of latency.
        let due = 0;
        const typeNext = () => {
          const now = Date.now();
          if (over || finished || now >= stopTypingAt) return;
          generatorLag.add(Math.max(0, now - due), { bucket: bucketOf(now) });
          seq += 1;
          const text = `${marker(now, vu, seq, myInstance)} `;
          editsSent.add(1, { bucket: bucketOf(now) });
          send(frameDocUpdate(typist.next(text)));
          const delay = EDIT_MS * jitter(0.5, 1.5);
          due = now + delay;
          after(typeNext, delay);
        };
        const firstDelay = EDIT_MS * jitter(0.2, 1.2);
        due = Date.now() + firstDelay;
        after(typeNext, firstDelay);

        const cursor = () => {
          if (over || finished) return;
          send(framePresence(`Load ${vu}`, '#2563eb'));
          after(cursor, jitter(4000, 6000));
        };
        after(cursor, jitter(1000, 5000));

        const watch = () => {
          if (over) return;
          const now = Date.now();
          if (now >= endAt) {
            finished = true;
            abandon();
          } else if (heartbeatMs > 0 && now - lastHeard > silenceLimitMs(heartbeatMs)) {
            // A peer that stopped without closing (frozen, partitioned): the
            // outage began when we last heard from it, not when we noticed.
            if (lostAt === 0) lostAt = lastHeard;
            silentDeaths.add(1, { bucket: bucketOf(now) });
            unexpectedCloses.add(1, { bucket: bucketOf(now) });
            abandon();
          } else {
            after(watch, 250);
          }
        };
        after(watch, 250);
      };

      // A connect that never completes (a frozen peer that still accepts TCP
      // connections) must not hold a user forever.
      handshakeTimer = setTimeout(() => {
        if (welcomed || over) return;
        handshakeTimeouts.add(1, { bucket: bucketOf(Date.now()) });
        abandon();
      }, HANDSHAKE_TIMEOUT_MS);

      ws.onmessage = (event) => {
        lastHeard = Date.now();
        const frame = parseFrame(event.data);
        switch (frame.type) {
          case 'welcome':
            welcomed = true;
            heartbeatMs = frame.heartbeatMs;
            send(frameSyncStep1());
            break;
          case 'resume-token':
            token = frame.token;
            break;
          case 'ping':
            send(framePong());
            break;
          case 'sync-step1': {
            // The server's state vector: re-send whatever of mine it lacks.
            // This is how edits lost to a dying connection reach the room.
            const have = frame.stateVector.get(100000 + vu) || 0;
            for (const update of typist.missingFrom(have)) send(frameDocUpdate(update));
            break;
          }
          case 'sync-step2': {
            if (!synced) {
              synced = true;
              const now = Date.now();
              joinTime.add(now - connectStarted);
              if (lostAt !== 0) {
                reconverge.add(now - lostAt, { bucket: bucketOf(now) });
                lostAt = 0;
              }
              failures = 0;
            }
            break;
          }
          case 'doc-update': {
            const now = Date.now();
            for (const m of extractMarkers(frame.update)) {
              if (m.vu === vu) continue;
              const ms = now - m.sentAt;
              const tags = { bucket: bucketOf(now) };
              editsReceived.add(1, tags);
              if (MODE === 'lb') propagationLb.add(ms, tags);
              else if (m.instance === myInstance) propagationSame.add(ms, tags);
              else propagationCross.add(ms, tags);
            }
            break;
          }
          case 'presence':
          case 'presence-remove':
            break;
          default:
            unknownFrames.add(1);
        }
      };

      ws.onclose = () => {
        if (!over && !finished) {
          if (lostAt === 0) lostAt = Date.now();
          if (welcomed) unexpectedCloses.add(1, { bucket: bucketOf(Date.now()) });
        }
        finish();
      };
      ws.onerror = () => undefined; // always followed by a close
    });

  while (Date.now() < endAt) {
    const reached = await session();
    if (Date.now() >= endAt) break;
    if (!reached) {
      connectFailures.add(1, { bucket: bucketOf(Date.now()) });
      if (lostAt === 0) lostAt = Date.now();
    }
    // Whatever happened, try somewhere else: a dead instance is the likeliest reason.
    if (MODE === 'direct') {
      const others = INSTANCES.map((_, i) => i).filter((i) => i !== instance);
      instance = others[Math.floor(Math.random() * others.length)];
    }
    failures += 1;
    await nap(backoffMs(failures));
  }
}

export function handleSummary(data) {
  return {
    [OUT]: JSON.stringify(
      { config: { VUS, ROOM_SIZE, RAMP_S, HOLD_S, DRAIN_S, EDIT_MS, MODE, RUN, BUCKET_S }, metrics: data.metrics },
      null,
      2,
    ),
    stdout: `\nk6 finished: ${VUS} VUs, mode ${MODE}, summary at ${OUT}\n`,
  };
}
