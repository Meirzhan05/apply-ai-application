// Each dashboard has one serial refresh loop. Validators belong to that
// dashboard only; private workspace responses never enter a shared cache.
export function createWorkspaceRefresh<T>(onState: (state: T) => void) {
  let running = false;
  let etag: string | undefined;
  let state: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<T> | undefined;
  let controller: AbortController | undefined;

  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (running && !document.hidden) timer = setTimeout(poll, 15_000);
  };
  const read = (conditional: boolean): Promise<T> => {
    const abort = new AbortController();
    controller = abort;
    const request = (async () => {
      const response = await fetch("/api/state", {
        cache: "no-store",
        signal: abort.signal,
        headers: conditional && etag ? { "If-None-Match": etag } : {},
      });
      if (response.status === 304 && state !== undefined) return state;
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load workspace.");
      if (running && !abort.signal.aborted) {
        etag = response.headers.get("etag") || undefined;
        state = body as T;
        onState(state);
      }
      return body as T;
    })();
    pending = request;
    void request.finally(() => {
      if (pending === request) { pending = undefined; controller = undefined; }
    }).catch(() => undefined);
    return request;
  };
  async function poll() {
    if (!running || document.hidden) return;
    try { await (pending || read(true)); }
    catch { /* A transient failure is retried on the next visible poll. */ }
    finally { schedule(); }
  }
  const visibilityChanged = () => {
    clear();
    if (!document.hidden) void poll();
  };
  return {
    start() {
      if (running) return;
      running = true;
      document.addEventListener("visibilitychange", visibilityChanged);
      schedule();
    },
    stop() {
      running = false;
      clear();
      document.removeEventListener("visibilitychange", visibilityChanged);
      controller?.abort();
    },
    async reload(): Promise<T> {
      // An explicit reload after an action must happen after any older read.
      while (pending) { try { await pending; } catch { /* Retry the explicit read. */ } }
      if (!running) throw new Error("Workspace refresh stopped.");
      return read(false);
    },
  };
}
