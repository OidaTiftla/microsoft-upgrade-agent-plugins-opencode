export interface CombinedAbortSignal {
  readonly dispose: () => void;
  readonly signal: AbortSignal;
}

export function combineAbortSignals(
  signals: readonly AbortSignal[],
): CombinedAbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  const listeners = signals.map((signal) => ({
    abort: () => abort(signal),
    signal,
  }));
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) abort(aborted);
  else
    for (const listener of listeners)
      listener.signal.addEventListener("abort", listener.abort, { once: true });

  return {
    dispose: () => {
      for (const listener of listeners)
        listener.signal.removeEventListener("abort", listener.abort);
    },
    signal: controller.signal,
  };
}
