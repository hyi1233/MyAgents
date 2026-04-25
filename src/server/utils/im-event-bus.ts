// IM Pipeline v2 — Pattern B: ImEventBus
//
// Replaces the legacy module-level `imStreamCallback` singleton with a
// per-session pub/sub bus. Every SDK event tagged with the requestId of the
// user message currently being processed; subscribers filter by requestId
// to deliver events to the right reply slot.
//
// Architectural win: the legacy `imCallbackNulledDuringTurn` flag and all
// the "callback replaced / stale event leak" defensive code go away —
// stale events from a finished turn carry the old requestId; new
// subscribers filter them out. Wrong-routing becomes structurally
// impossible, not "guarded against".
//
// Sidecar is per-session (one Sidecar serves one logical session), so the
// module-level singleton bus instance maps 1:1 to "events for this session".
// In Pattern C, /api/im/events long-poll consumes from this same bus with
// `since=<lastSeq>` for crash-recovery semantics.

export type ImEventType =
  | 'delta'              // streaming text fragment
  | 'block-end'          // a complete text block boundary
  | 'complete'           // turn finished (success)
  | 'error'              // turn failed / aborted
  | 'permission-request' // SDK asks user permission
  | 'activity'           // non-text content_block_start (thinking / tool_use)
  | 'cancelled'          // explicit user cancel (Pattern D)
  | 'gap';               // ring buffer overflow — some events were dropped

export interface ImEvent {
  /** Monotonically increasing sequence per bus instance. Subscribers can
   *  resume after disconnect using `subscribe(lastSeq, cb)`. */
  seq: number;
  /** The user message this event belongs to. `null` = session-level
   *  (e.g. system init, gap announcement) — broadcast to all subscribers. */
  requestId: string | null;
  type: ImEventType;
  /** Event payload. Type depends on `type`:
   *    - 'delta' / 'block-end' / 'complete' / 'error' / 'cancelled': string
   *    - 'permission-request': JSON string with { requestId, toolName, input }
   *    - 'activity': string (content block type)
   *    - 'gap': { droppedSeqs: [from, to] } */
  data?: unknown;
  ts: number;
}

export type ImEventSubscriber = (event: ImEvent) => void;

const MAX_BUFFER = 1000;

class ImEventBusImpl {
  private buffer: ImEvent[] = [];
  private nextSeq = 1;
  private subscribers = new Set<ImEventSubscriber>();

  /** Emit an event. Stamps it with the next sequence number, appends to ring
   *  buffer (FIFO eviction), then fans out to all live subscribers.
   *  Subscriber exceptions are logged but do not block other subscribers. */
  emit(requestId: string | null, type: ImEventType, data?: unknown): void {
    const seq = this.nextSeq++;
    const event: ImEvent = { seq, requestId, type, data, ts: Date.now() };

    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      // Ring eviction. Pattern C surfaces this as a 'gap' event so the Rust
      // ImEventConsumer knows to warn the user. For Pattern B (single SSE
      // per /api/im/chat), eviction during a single turn would mean SDK is
      // pumping >1000 events — unlikely without Pattern C scale; still
      // safer to drop oldest than blow memory.
      const dropped = this.buffer.shift();
      if (dropped) {
        const gap: ImEvent = {
          seq: this.nextSeq++,
          requestId: null,
          type: 'gap',
          data: { droppedSeqs: [dropped.seq, dropped.seq] },
          ts: Date.now(),
        };
        this.buffer.push(gap);
        for (const sub of this.subscribers) {
          try { sub(gap); } catch (e) { console.error('[im-bus] subscriber threw on gap', e); }
        }
      }
    }

    for (const sub of this.subscribers) {
      try { sub(event); } catch (e) { console.error('[im-bus] subscriber threw', e); }
    }
  }

  /** Subscribe to events with seq > sinceSeq.
   *  - To get only future events: pass `bus.currentSeq()` as sinceSeq.
   *  - To replay from start (e.g. crash recovery): pass 0.
   *  - Returns an unsubscribe function — caller MUST call it to avoid leaks. */
  subscribe(sinceSeq: number, cb: ImEventSubscriber): () => void {
    // Replay buffered events newer than sinceSeq before adding to live set.
    for (const event of this.buffer) {
      if (event.seq > sinceSeq) {
        try { cb(event); } catch (e) { console.error('[im-bus] subscriber threw on replay', e); }
      }
    }
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  /** Latest assigned sequence (i.e. the seq of the most recently emitted
   *  event). New subscribers should pass this to receive only future events. */
  currentSeq(): number {
    return this.nextSeq - 1;
  }

  /** Number of events currently held in the ring buffer. Diagnostic only. */
  size(): number {
    return this.buffer.length;
  }

  /** Number of active subscribers. Diagnostic only. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Reset bus state. Called on session reset / sidecar shutdown.
   *  Subscribers are NOT removed automatically — they can still receive
   *  fresh events; the unsubscribe handle remains the canonical lifecycle
   *  controller (caller-owned). */
  clear(): void {
    this.buffer.length = 0;
    this.nextSeq = 1;
  }
}

/** Per-sidecar singleton. Sidecar is 1:1 with session, so this implicitly
 *  scopes to one session. */
export const imEventBus = new ImEventBusImpl();
