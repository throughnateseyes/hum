/**
 * Asking a worker for things: every request gets its own number, and its answer settles the promise it
 * was made with. The worker starts the first time it is asked; one that fails to start is replaced the next.
 */

type Job = { resolve: (m: never) => void; reject: (e: Error) => void; onDownload?: (frac: number) => void };

export class Desk {
  private worker: Worker | null = null;
  private nextId = 1;
  private jobs = new Map<number, Job>();

  constructor(
    private make: () => Worker,
    private failed: string,
  ) {}

  private get(): Worker {
    if (this.worker) return this.worker;
    const w = this.make();
    w.onmessage = (e) => {
      const m = e.data;
      const j = this.jobs.get(m.id);
      if (!j) return;
      if (m.type === 'download') {
        j.onDownload?.(m.frac);
        return;
      }
      this.jobs.delete(m.id);
      if (m.type === 'cancelled') j.reject(new DOMException('Cancelled', 'AbortError'));
      else if (m.type === 'error') j.reject(new Error(m.message));
      else j.resolve(m as never);
    };
    w.onerror = (e) => {
      for (const j of this.jobs.values()) j.reject(new Error(e.message || this.failed));
      this.jobs.clear();
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    return (this.worker = w);
  }

  ask<T>(m: Record<string, unknown>, move: Transferable[] = [], signal?: AbortSignal, onDownload?: (frac: number) => void): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const stop = () => {
        this.worker?.postMessage({ type: 'cancel', id });
        this.jobs.delete(id);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const off = () => signal?.removeEventListener('abort', stop);
      this.jobs.set(id, {
        resolve: (v) => {
          off();
          resolve(v as T);
        },
        reject: (e) => {
          off();
          reject(e);
        },
        onDownload,
      });
      signal?.addEventListener('abort', stop, { once: true });
      this.get().postMessage({ id, ...m }, move);
    });
  }

  /** tell it something that needs no answer */
  tell(m: Record<string, unknown>) {
    this.worker?.postMessage({ id: 0, ...m });
  }
}
