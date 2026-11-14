/** Ordered run events: persisted for replay and fanned out live to subscribed browsers. */
import type { RunEvent, Store } from '../store/types.js';

type Listener = (event: RunEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(runId: string, listener: Listener): () => void {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId)!.add(listener);
  return () => { listeners.get(runId)?.delete(listener); if (!listeners.get(runId)?.size) listeners.delete(runId); };
}

export class EventSink {
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private store: Store, public runId: string, startSeq = 0) { this.seq = startSeq; }

  /** Records one event. Writes are serialised so sequence order equals storage order. */
  emit(node: string, type: string, summary: string, payload: unknown = {}): Promise<void> {
    const event: RunEvent = { runId: this.runId, seq: ++this.seq, at: new Date().toISOString(), node, type, summary: summary.slice(0, 300), payload };
    this.queue = this.queue.then(() => this.store.events.insert(event)).then(() => {
      for (const l of listeners.get(this.runId) ?? []) { try { l(event); } catch { /* a broken listener must not stop the run */ } }
    });
    return this.queue;
  }

  blob(content: string) { return this.store.blobs.insert(this.runId, content); }
  flush() { return this.queue; }
  get lastSeq() { return this.seq; }
}
