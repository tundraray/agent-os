import fc from 'fast-check';
import { z } from 'zod';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type {
  TokenCounter,
  TokenCountRequest,
  TokenCountResult,
} from '../model/token-counter.js';
import {
  type ContextBuilder,
  createContextBuilder,
  type PacketFrame,
} from './context-builder.js';
import type { EngineLogger } from '../ports.js';
import type { ClaimLine, EvidenceItem } from './role-packets.js';

// ContextBuilder (design-engine.md, C3; AC-06.1–AC-06.3, DC-7, DC-8, AC-05.2): the packet of a role is
// counted through the TokenCounter port and fits `windowTokens − marginTokens` of the role in the
// investigation's configuration; a mandatory record is never cut.
// Defects caught: a mandatory evidence or controller record cut to fit; the window taken from package
// defaults instead of the investigation's configuration; earlier claims packed oldest first; a worker
// packet carrying more than its subquestion and its evidence.
// Boundary double: the token counter, one token per character of the instructions and messages.

const OutputSchema = z.object({ claims: z.array(z.string()) });

const charCounter = (): TokenCounter => ({
  countInputTokens(request: TokenCountRequest): Promise<TokenCountResult> {
    const inputTokens =
      request.system.length +
      request.messages.reduce((sum, message) => sum + message.content.length, 0);
    return Promise.resolve({ outcome: 'counted', inputTokens });
  },
});

const silentLogger: EngineLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

type RoleWindow = Pick<ProcessConfig['roles']['worker'], 'windowTokens' | 'marginTokens'>;

const frame = (window: RoleWindow): PacketFrame => ({
  roleConfig: { model: 'anthropic/claude-haiku-5-5', effort: 'low', ...window },
  instructions: 'Answer the subquestion from the evidence.',
  outputSchema: OutputSchema,
  signal: new AbortController().signal,
});

const evidence = (evidenceId: string, size: number): EvidenceItem => ({
  evidenceId,
  text: `${evidenceId}:${'e'.repeat(size)}`,
});

const contentOf = (result: Awaited<ReturnType<ContextBuilder['buildWorkerPacket']>>): string => {
  if (result.outcome !== 'packed') throw new Error(`expected packed, got ${result.outcome}`);
  return result.messages.map((message) => message.content).join('\n');
};

describe('ContextBuilder', () => {
  it('AC-06.1: a packet fits the role window, or the whole mandatory evidence is reported as needs_narrowing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 6_000 }),
        fc.integer({ min: 0, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 1_500 }), { maxLength: 8 }),
        async (windowTokens, marginPercent, sizes) => {
          const marginTokens = Math.floor((windowTokens * marginPercent) / 100);
          const items = sizes.map((size, index) => evidence(`ev-${index}`, size));
          const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

          const result = await builder.buildWorkerPacket(frame({ windowTokens, marginTokens }), {
            subquestion: 'Which service failed first?',
            evidence: items,
          });

          if (result.outcome === 'packed') {
            expect(result.inputTokens).toBeLessThanOrEqual(windowTokens - marginTokens);
            const content = contentOf(result);
            for (const item of items) expect(content).toContain(item.text);
            return;
          }
          expect(result.outcome).toBe('needs_narrowing');
          if (result.outcome !== 'needs_narrowing') return;
          expect(result.materialTokens).toBeGreaterThan(windowTokens - marginTokens);
          expect(result.limitTokens).toBe(windowTokens - marginTokens);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Packet size of the material below with the char counter: instructions 41 + message 202.
  const subquestion = 'Which service failed first?';
  const material = { subquestion, evidence: [evidence('ev-1', 40), evidence('ev-2', 30)] };
  const MATERIAL_TOKENS = 243;

  it.each([
    ['fits exactly at window − margin', { windowTokens: 253, marginTokens: 10 }, 'packed'],
    ['one token over window − margin', { windowTokens: 252, marginTokens: 10 }, 'needs_narrowing'],
    ['window of this investigation smaller than the shipped worker window', { windowTokens: 150, marginTokens: 0 }, 'needs_narrowing'],
    ['window of this investigation larger', { windowTokens: 1_000, marginTokens: 50 }, 'packed'],
  ] as const)('AC-06.3, DC-7: worker packet when %s', async (_, window, outcome) => {
    const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

    const result = await builder.buildWorkerPacket(frame(window), material);

    expect(result.outcome).toBe(outcome);
    if (result.outcome === 'packed') expect(result.inputTokens).toBe(MATERIAL_TOKENS);
    if (result.outcome === 'needs_narrowing') {
      expect(result).toEqual({
        outcome: 'needs_narrowing',
        materialTokens: MATERIAL_TOKENS,
        limitTokens: window.windowTokens - window.marginTokens,
      });
    }
  });

  it('AC-05.2: a worker packet holds only its subquestion and its evidence', async () => {
    const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

    const result = await builder.buildWorkerPacket(
      frame({ windowTokens: 1_000, marginTokens: 0 }),
      material,
    );

    expect(result.outcome).toBe('packed');
    if (result.outcome !== 'packed') return;
    expect(result.system).toBe('Answer the subquestion from the evidence.');
    expect(result.messages).toEqual([
      {
        role: 'user',
        content:
          `<assignment>\n${subquestion}\n</assignment>\n` +
          `<evidence id="ev-1">\nev-1:${'e'.repeat(40)}\n</evidence>\n` +
          `<evidence id="ev-2">\nev-2:${'e'.repeat(30)}\n</evidence>`,
      },
    ]);
  });

  const claim = (claimId: string, day: number): ClaimLine => ({
    claimId,
    status: 'unverified',
    text: `claim ${claimId} text`,
    revisedAt: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`),
  });
  const controllerMaterial = {
    mandatory: { planRevision: { goal: 'why did payments fail' }, admissible: ['wait'] },
    taskCounts: [{ type: 'source.fetch', status: 'succeeded', failureReason: null, count: 2 }],
    claims: [claim('c-old', 1), claim('c-new', 9), claim('c-mid', 5), claim('c-older', 2)],
  };

  it.each([
    ['all earlier claims fit', 2_000, ['c-new', 'c-mid', 'c-older', 'c-old']],
    ['room for two earlier claims', 380, ['c-new', 'c-mid']],
    ['room for no earlier claim', 300, []],
  ] as const)(
    'C3: controller packet packs earlier claims newest first when %s',
    async (_, windowTokens, packedClaims) => {
      const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

      const result = await builder.buildControllerPacket(
        frame({ windowTokens, marginTokens: 0 }),
        controllerMaterial,
      );

      expect(result.outcome).toBe('packed');
      if (result.outcome !== 'packed') return;
      expect(result.inputTokens).toBeLessThanOrEqual(windowTokens);
      const content = result.messages.map((message) => message.content).join('\n');
      const packed = [...content.matchAll(/^(c-[a-z]+) \[/gm)].map((match) => match[1]);
      expect(packed).toEqual(packedClaims);
      expect(content).toContain('{"planRevision":{"goal":"why did payments fail"},"admissible":["wait"]}');
      expect(content).toContain('"type":"source.fetch"');
    },
  );

  it('DC-8: controller packet whose mandatory part exceeds the window is refused without truncation', async () => {
    const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

    const result = await builder.buildControllerPacket(
      frame({ windowTokens: 260, marginTokens: 13 }),
      controllerMaterial,
    );

    expect(result).toEqual({ outcome: 'context_overflow', mandatoryTokens: 254, limitTokens: 247 });
  });

  // T7.3: a refused count stopped the investigation with no trace of why. Defect caught: the refusal is taken as a
  // fitting packet, or it is not logged with its status and class, or the log carries the packet.
  it('a failed count is returned, not taken as a fitting packet, and logged with its status and class only', async () => {
    const failing: TokenCounter = {
      countInputTokens: () => Promise.resolve({ outcome: 'failed', statusCode: 400, errorClass: 'invalid_request_error' }),
    };
    const warnings: unknown[][] = [];
    const logger = { ...silentLogger, warn: (...line: unknown[]) => void warnings.push(line) };
    const builder = createContextBuilder({ tokenCounter: failing, logger });

    const result = await builder.buildWorkerPacket(
      frame({ windowTokens: 1_000, marginTokens: 0 }),
      material,
    );

    expect(result).toEqual({ outcome: 'count_failed', statusCode: 400 });
    expect(warnings).toEqual([
      ['token count failed', { model: 'anthropic/claude-haiku-5-5', statusCode: 400, errorClass: 'invalid_request_error' }],
    ]);
  });
});
