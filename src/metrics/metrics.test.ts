import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  CloseCode,
  encodeDocUpdate,
  encodeHello,
  encodePong,
  PROTOCOL_VERSION,
} from '../protocol/index.js';
import { baseConfig, joinRoom, once, startServer, type Harness } from '../gateway/testSupport.js';
import { signResumeToken } from '../session/resumeToken.js';
import { PromMetrics } from './prom.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Reads one sample's value out of the Prometheus text format. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    if (wanted.every((label) => line.includes(label))) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return 0;
}

async function start(overrides = {}) {
  const metrics = new PromMetrics('test-instance');
  harness = await startServer(baseConfig(overrides), { metrics });
  metrics.bindGauges({ sockets: () => harness!.gateway.connectionCount(), rooms: () => harness!.gateway.roomCount() });
  return metrics;
}

describe('metrics', () => {
  it('reports connected sockets and rooms in memory as live values', async () => {
    const metrics = await start();
    const a = await joinRoom(harness!.url, 'room-1');
    await joinRoom(harness!.url, 'room-1');
    await joinRoom(harness!.url, 'room-2');
    let text = await metrics.render();
    expect(sample(text, 'strand_connected_sockets')).toBe(3);
    expect(sample(text, 'strand_rooms_in_memory')).toBe(2);

    a.ws.close();
    await once(a.ws, 'close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    text = await metrics.render();
    expect(sample(text, 'strand_connected_sockets')).toBe(2);
  });

  it('labels every series with the instance, and includes process metrics', async () => {
    const metrics = await start();
    const text = await metrics.render();
    expect(text).toContain('instance="test-instance"');
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('counts document updates by origin', async () => {
    const metrics = await start();
    const { ws } = await joinRoom(harness!.url, 'room-u');
    const { Doc } = await import('yjs').then((Y) => ({ Doc: Y.Doc }));
    const doc = new Doc();
    let update: Uint8Array = new Uint8Array();
    doc.on('update', (u: Uint8Array) => (update = u));
    doc.getText('content').insert(0, 'x');
    ws.send(encodeDocUpdate(update));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sample(await metrics.render(), 'strand_doc_updates_total', { origin: 'local' })).toBe(1);
  });

  it('counts a new handshake, a resume, and a rejected token separately; resumes are the reconnect count', async () => {
    const metrics = await start();
    const first = await joinRoom(harness!.url, 'room-h');
    const forged = signResumeToken('some-other-secret-of-sufficient-length-0000', {
      clientId: 'x',
      roomId: 'room-h',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await joinRoom(harness!.url, 'room-h', forged);
    first.ws.close();
    await once(first.ws, 'close');
    await joinRoom(harness!.url, 'room-h', first.token);

    const text = await metrics.render();
    expect(sample(text, 'strand_handshakes_total', { result: 'new' })).toBe(1);
    expect(sample(text, 'strand_handshakes_total', { result: 'token_rejected' })).toBe(1);
    expect(sample(text, 'strand_handshakes_total', { result: 'resumed' })).toBe(1);
  });

  it('counts why connections ended: heartbeat, bad message, version mismatch, and clients leaving', async () => {
    const metrics = await start({ heartbeatIntervalMs: 40, heartbeatMaxMissedPongs: 2 });
    const silent = await joinRoom(harness!.url, 'room-d'); // never answers pings
    await once(silent.ws, 'close');

    const wrongVersion = new WebSocket(harness!.url);
    await once(wrongVersion, 'open');
    wrongVersion.send(encodeHello('room-d', PROTOCOL_VERSION + 1));
    await once(wrongVersion, 'close');

    const leaver = await joinRoom(harness!.url, 'room-d');
    const stay = setInterval(() => leaver.ws.send(encodePong()), 10); // keep this one alive
    leaver.ws.close();
    await once(leaver.ws, 'close');
    clearInterval(stay);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const text = await metrics.render();
    expect(sample(text, 'strand_disconnects_total', { reason: 'heartbeat_timeout' })).toBe(1);
    expect(sample(text, 'strand_disconnects_total', { reason: 'version_mismatch' })).toBe(1);
    expect(sample(text, 'strand_disconnects_total', { reason: 'client_closed' })).toBeGreaterThanOrEqual(1);
  });

  it('counts backpressure disconnects both by reason and in the dedicated series', async () => {
    const metrics = new PromMetrics('bp');
    // Count as the gateway would when a Connection reports a backpressure close.
    metrics.disconnect('backpressure');
    metrics.disconnect('backpressure');
    metrics.disconnect('heartbeat_timeout');
    const text = await metrics.render();
    expect(sample(text, 'strand_backpressure_disconnects_total')).toBe(2);
    expect(sample(text, 'strand_disconnects_total', { reason: 'backpressure' })).toBe(2);
    expect(CloseCode.BackpressureDisconnect).toBe(4003);
  });

  it('records snapshot and fan-out durations as histograms', async () => {
    const metrics = new PromMetrics('h');
    metrics.snapshot(0.012);
    metrics.fanoutPublished(0.001);
    metrics.fanoutReceived(0.004);
    metrics.fanoutReceived(-0.5); // clock skew can make this negative; it must not poison the histogram
    const text = await metrics.render();
    expect(sample(text, 'strand_snapshot_duration_seconds_count')).toBe(1);
    expect(sample(text, 'strand_fanout_publish_seconds_count')).toBe(1);
    expect(sample(text, 'strand_fanout_receive_seconds_count')).toBe(2);
    expect(sample(text, 'strand_fanout_receive_seconds_bucket', { le: '0.0005' })).toBe(1); // the clamped skew value
  });
});


