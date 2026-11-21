// Runs first in the executor process, before QuickJS loads. Imports nothing (the executor may read only
// its own directory and QuickJS).

/**
 * `_debugProcess` opens the inspector of another process of the same OS user, and no permission scope
 * checks it; `dlopen` and `binding` are closed by `--permission` already and go as a second barrier (spike).
 */
const REMOVED_FROM_PROCESS = ['_debugProcess', 'dlopen', 'binding'] as const;

/** Removes from `process` what the permission model leaves open; throws when one stays. */
export function prepareProcess(): void {
  for (const key of REMOVED_FROM_PROCESS) {
    if (!Reflect.deleteProperty(process, key) || key in process) {
      throw new Error(`Cannot remove process.${key}`);
    }
  }
}
