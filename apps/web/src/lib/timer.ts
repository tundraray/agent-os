/** Starts a stopwatch outside render (React Compiler purity); the returned function gives the milliseconds since. */
export const startTimer = (): (() => number) => {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
};
