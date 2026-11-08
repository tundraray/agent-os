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
import type { ClaimLine, EvidencePage } from './role-packets.js';

// ContextBuilder (design-engine.md, C3; AC-06.1–AC-06.3, DC-7, DC-8, AC-05.2): the packet of a role is
// counted through the TokenCounter port and fits `windowTokens − marginTokens` of the role in the
// investigation's configuration; a mandatory record is never cut.
// Defects caught: a mandatory evidence or controller record cut to fit; earlier claims packed oldest
// first; a worker packet carrying more than its subquestion and its evidence. The window taken from the
// investigation's configuration rather than package defaults is INT-1 C2.
// Boundary double: the token counter, one token per character of the instructions and messages.

const OutputSchema = z.object({ claims: z.array(z.string()) });

const charCounter = (): TokenCounter => ({
  countInputTokens(request: TokenCountRequest): Promise<TokenCountResult> {
    const inputTokens =
      request.system.length +
      request.messages.reduce((sum, message) => sum + message.content.length, 0);
    return Promise.resolve({ outcome: 'counted', inputTokens });
  },
  countTurnInputTokens: () => Promise.reject(new Error('a role packet counts no agent turn')),
});

const silentLogger: EngineLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

type RoleWindow = Pick<ProcessConfig['roles']['worker'], 'windowTokens' | 'marginTokens'>;

const frame = (window: RoleWindow): PacketFrame => ({
  roleConfig: { model: 'anthropic/claude-haiku-5-5', effort: 'low', ...window },
  instructions: 'Answer the subquestion from the evidence.',
  outputSchema: OutputSchema,
  signal: new AbortController().signal,
});

/** A page of one record of `size` characters after its page id. */
const page = (evidenceId: string, size: number): EvidencePage => ({
  evidenceId,
  records: [`${evidenceId}:${'e'.repeat(size)}`],
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
          const pages = sizes.map((size, index) => page(`ev-${index}`, size));
          const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

          const result = await builder.buildWorkerPacket(frame({ windowTokens, marginTokens }), {
            subquestion: 'Which service failed first?',
            pages,
          });

          if (result.outcome === 'packed') {
            expect(result.inputTokens).toBeLessThanOrEqual(windowTokens - marginTokens);
            const content = contentOf(result);
            for (const record of pages.flatMap((item) => item.records)) expect(content).toContain(JSON.stringify(record));
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

  // Packet size of the material below with the char counter: instructions 41 + message 262.
  const subquestion = 'Which service failed first?';
  const material = { subquestion, pages: [page('ev-1', 40), page('ev-2', 30)] };
  const MATERIAL_TOKENS = 303;

  it.each([
    ['fits exactly at window − margin', { windowTokens: 313, marginTokens: 10 }, 'packed'],
    ['one token over window − margin', { windowTokens: 312, marginTokens: 10 }, 'needs_narrowing'],
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
          `<evidence id="ev-1">\n<record number="0">"ev-1:${'e'.repeat(40)}"</record>\n</evidence>\n` +
          `<evidence id="ev-2">\n<record number="0">"ev-2:${'e'.repeat(30)}"</record>\n</evidence>`,
      },
    ]);
  });

  // KD-1, AC-11.1 (data half): a claim's pointer names records by their number in the page, so the worker must see
  // those numbers. Defect caught: a worker shown its pages without record numbers, numbered across pages instead of
  // within each, or in an order other than the page's `items`.
  it('KD-1: worker input numbers the records of every page from 0 in the order of its items', async () => {
    const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

    const result = await builder.buildWorkerPacket(frame({ windowTokens: 1_000, marginTokens: 0 }), {
      subquestion,
      pages: [
        { evidenceId: 'p1', records: [{ traceId: 't-9' }, { traceId: 't-1' }, { traceId: 't-5' }] },
        { evidenceId: 'p2', records: [{ count: 412 }] },
      ],
    });

    expect(contentOf(result)).toBe(
      `<assignment>\n${subquestion}\n</assignment>\n` +
        '<evidence id="p1">\n' +
        '<record number="0">{"traceId":"t-9"}</record>\n' +
        '<record number="1">{"traceId":"t-1"}</record>\n' +
        '<record number="2">{"traceId":"t-5"}</record>\n' +
        '</evidence>\n' +
        '<evidence id="p2">\n<record number="0">{"count":412}</record>\n</evidence>',
    );
  });

  const claim = (claimId: string, day: number): ClaimLine => ({
    claimId,
    status: 'unverified',
    text: `claim ${claimId} text`,
    revisedAt: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`),
  });
  const controllerMaterial = {
    stable: { tools: [], planRevision: { goal: 'why did payments fail' } },
    changing: { admissible: ['wait'] },
    rejectedAttempts: [],
    taskCounts: [{ type: 'source.fetch', status: 'succeeded', failureReason: null, count: 2 }],
    claims: [claim('c-old', 1), claim('c-new', 9), claim('c-mid', 5), claim('c-older', 2)],
  };

  it.each([
    ['all earlier claims fit', 2_000, ['c-new', 'c-mid', 'c-older', 'c-old']],
    ['room for two earlier claims', 440, ['c-new', 'c-mid']],
    ['room for no earlier claim', 340, []],
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
      expect(content).toContain('<plan_revision>\n{"goal":"why did payments fail"}\n</plan_revision>');
      expect(content).toContain('{"admissible":["wait"],"rejectedAttempts":[]}');
      expect(content).toContain('"type":"source.fetch"');
    },
  );

  it('DC-8: controller packet whose mandatory part exceeds the window is refused without truncation', async () => {
    const builder = createContextBuilder({ tokenCounter: charCounter(), logger: silentLogger });

    const result = await builder.buildControllerPacket(
      frame({ windowTokens: 320, marginTokens: 13 }),
      controllerMaterial,
    );

    expect(result).toEqual({ outcome: 'context_overflow', mandatoryTokens: 313, limitTokens: 307 });
  });

  // T7.3: a refused count stopped the investigation with no trace of why. Defect caught: the refusal is taken as a
  // fitting packet, or it is not logged with its status and class, or the log carries the packet.
  it('a failed count is returned, not taken as a fitting packet, and logged with its status and class only', async () => {
    const failing: TokenCounter = {
      countInputTokens: () => Promise.resolve({ outcome: 'failed', statusCode: 400, errorClass: 'invalid_request_error' }),
      countTurnInputTokens: () => Promise.reject(new Error('a role packet counts no agent turn')),
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
