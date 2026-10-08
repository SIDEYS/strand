import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { DisconnectReason, HandshakeResult, MetricsSink, UpdateOrigin } from './sink.js';

/** Sub-millisecond to seconds: fan-out is normally a few milliseconds, and the
 * interesting behaviour is the tail. */
const LATENCY_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15];

/**
 * Prometheus metrics for one instance. A registry per instance, not the global
 * default, so tests (and several instances in one process) don't share state.
 *
 * Process metrics come from prom-client's defaults: resident memory, heap,
 * event-loop lag, GC, open file descriptors. Event-loop lag and memory are what
 * say whether an instance is saturated, so they are kept rather than
 * reinvented.
 */
export class PromMetrics implements MetricsSink {
  readonly registry = new Registry();

  #disconnects: Counter<'reason'>;
  #backpressure: Counter;
  #handshakes: Counter<'result'>;
  #updates: Counter<'origin'>;
  #publishSeconds: Histogram;
  #receiveSeconds: Histogram;
  #snapshotSeconds: Histogram;
  #snapshotConflicts: Counter;
  #opsDropped: Counter;
  #opsCompacted: Counter;
  #flushFailures: Counter;
  #sources = { sockets: () => 0, rooms: () => 0 };

  constructor(instanceId: string) {
    this.registry.setDefaultLabels({ instance: instanceId });
    collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];

    // Gauges read the live value when scraped, so they can never drift from
    // the thing they describe. The sources are bound after construction,
    // once the gateway they describe exists.
    const sources = this.#sources;
    new Gauge({
      name: 'strand_connected_sockets',
      help: 'WebSocket connections currently open on this instance.',
      registers,
      collect() {
        this.set(sources.sockets());
      },
    });
    new Gauge({
      name: 'strand_rooms_in_memory',
      help: 'Rooms with at least one local member, held in memory.',
      registers,
      collect() {
        this.set(sources.rooms());
      },
    });
    this.#updates = new Counter({
      name: 'strand_doc_updates_total',
      help: 'Document changes applied. rate() of this is updates per second.',
      labelNames: ['origin'],
      registers,
    });
    this.#handshakes = new Counter({
      name: 'strand_handshakes_total',
      help: 'Completed handshakes. result="resumed" is the reconnect count.',
      labelNames: ['result'],
      registers,
    });
    this.#disconnects = new Counter({
      name: 'strand_disconnects_total',
      help: 'Connections ended, by why.',
      labelNames: ['reason'],
      registers,
    });
    this.#backpressure = new Counter({
      name: 'strand_backpressure_disconnects_total',
      help: 'Clients disconnected for not draining their socket fast enough.',
      registers,
    });
    this.#publishSeconds = new Histogram({
      name: 'strand_fanout_publish_seconds',
      help: 'Duration of a publish to Redis.',
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.#receiveSeconds = new Histogram({
      name: 'strand_fanout_receive_seconds',
      help: 'Time from another instance publishing a frame to this instance receiving it (compares wall clocks).',
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.#snapshotSeconds = new Histogram({
      name: 'strand_snapshot_duration_seconds',
      help: 'Duration of a successful snapshot write.',
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#snapshotConflicts = new Counter({ name: 'strand_snapshot_conflicts_total', help: 'Snapshot attempts that lost the version race.', registers });
    this.#opsDropped = new Counter({ name: 'strand_persist_ops_dropped_total', help: 'Buffered ops discarded on overflow (a snapshot covers them).', registers });
    this.#opsCompacted = new Counter({ name: 'strand_persist_ops_compacted_total', help: 'Op log rows removed by compaction.', registers });
    this.#flushFailures = new Counter({ name: 'strand_persist_flush_failures_total', help: 'Op log writes that failed and will be retried.', registers });
  }

  bindGauges(sources: { sockets: () => number; rooms: () => number }): void {
    this.#sources.sockets = sources.sockets;
    this.#sources.rooms = sources.rooms;
  }

  disconnect(reason: DisconnectReason): void {
    this.#disconnects.inc({ reason });
    if (reason === 'backpressure') this.#backpressure.inc();
  }
  handshake(result: HandshakeResult): void {
    this.#handshakes.inc({ result });
  }
  docUpdate(origin: UpdateOrigin): void {
    this.#updates.inc({ origin });
  }
  fanoutPublished(seconds: number): void {
    this.#publishSeconds.observe(seconds);
  }
  fanoutReceived(seconds: number): void {
    this.#receiveSeconds.observe(Math.max(0, seconds));
  }
  snapshot(seconds: number): void {
    this.#snapshotSeconds.observe(seconds);
  }
  snapshotConflict(): void {
    this.#snapshotConflicts.inc();
  }
  opsDropped(count: number): void {
    this.#opsDropped.inc(count);
  }
  opsCompacted(count: number): void {
    if (count > 0) this.#opsCompacted.inc(count);
  }
  flushFailed(): void {
    this.#flushFailures.inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
