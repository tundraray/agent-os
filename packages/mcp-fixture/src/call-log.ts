import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { FaultMode } from './fault-schedule.js';

const CallLogEntrySchema = z.strictObject({
  seq: z.int().min(1),
  tool: z.string(),
  argsHash: z.string(),
  occurrence: z.int().min(1),
  /** Fault mode applied to the call; null when no rule matched. */
  mode: z.string().nullable(),
  pid: z.int(),
});
type CallLogEntry = z.infer<typeof CallLogEntrySchema>;

/**
 * JSONL journal of `tools/call` requests (`FIXTURE_CALL_LOG`), shared by every fixture process started with the
 * same path. The file is the only counter, so occurrence numbers keep counting across a process restart.
 */
export class CallLog {
  constructor(private readonly path: string) {}

  /**
   * Appends the call before it is processed. `decide` receives the call's occurrence number (1-based, per tool and
   * argument hash) and returns the fault for it, which is logged and returned. The write is synchronous, so a
   * crash right after it still leaves the line in the file.
   */
  record<Fault extends { mode: FaultMode }>(
    call: { tool: string; argsHash: string },
    decide: (occurrence: number) => Fault | undefined,
  ): Fault | undefined {
    const entries = this.read();
    const occurrence =
      entries.filter((entry) => entry.tool === call.tool && entry.argsHash === call.argsHash).length + 1;
    const fault = decide(occurrence);
    const entry: CallLogEntry = {
      seq: entries.length + 1,
      tool: call.tool,
      argsHash: call.argsHash,
      occurrence,
      mode: fault?.mode ?? null,
      pid: process.pid,
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    return fault;
  }

  private read(): CallLogEntry[] {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => CallLogEntrySchema.parse(JSON.parse(line)));
  }
}
