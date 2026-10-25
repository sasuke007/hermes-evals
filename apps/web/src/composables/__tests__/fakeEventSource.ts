import type { EventSourceLike } from '@/composables/useSse';

/** An EventSource stand-in the test drives: open(), emit(type, data), fail(). */
export class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(public readonly url: string) {
    FakeEventSource.all.push(this);
  }

  static reset(): void {
    FakeEventSource.all = [];
  }

  /** The newest connection. */
  static get last(): FakeEventSource {
    const es = FakeEventSource.all[FakeEventSource.all.length - 1];
    if (!es) throw new Error('no EventSource was created');
    return es;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  emit(type: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: payload }));
    }
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

export const fakeFactory = (url: string): FakeEventSource => new FakeEventSource(url);
