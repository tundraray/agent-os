import { providerLatency, type LogRecord, type LogService, type PaymentModel, type Settlement } from '../dataset.js';
import type { Random } from '../prng.js';
import type { MechanismName } from './scenario-params.js';

/**
 * One way the generator plants a cause into the logs. It shapes the payment traces around the moment of change and
 * tells, from record fields alone, which records prove the planted cause, so the key is derived from the data.
 */
export interface Mechanism {
  readonly name: MechanismName;
  readonly kind: 'cause' | 'no_cause';
  /** Service where the planted change lives; `null` when nothing in the logs explains the symptom. */
  readonly service: LogService | null;
  paymentModel(changeMs: number): PaymentModel;
  /** Whether the record proves the planted cause; always `false` for `no_cause`. */
  isCauseEvidence(record: LogRecord, changeMs: number): boolean;
}

/** Local `provider-adapter` timeout everywhere except after the change of `timeout_lowered`; the `v1` values. */
const BASE_TIMEOUT_MS = 3_000;
const LOWERED_TIMEOUT_MS = 1_500;
/** Mean provider latency excess after `provider_slowed` changes; before it, the `v1` distribution. */
const SLOWED_LATENCY_MEAN_EXCESS_MS = 1_800;

/** Share of in-time payments that fail at the ledger or with no recorded reason; one mechanism raises its share. */
interface SettlementShares {
  ledgerError: number;
  unexplainedError: number;
}
const BASELINE_SHARES: SettlementShares = { ledgerError: 0.005, unexplainedError: 0.005 };
const RAISED_SHARE = 0.2;

function settleBy(shares: SettlementShares, random: Random): Settlement {
  const draw = random();
  if (draw < shares.ledgerError) {
    return 'ledger_error';
  }
  return draw < shares.ledgerError + shares.unexplainedError ? 'unexplained_error' : 'ok';
}

function settlementAfter(changeMs: number, raised: SettlementShares): PaymentModel['settlement'] {
  return (random, requestMs) => settleBy(requestMs >= changeMs ? raised : BASELINE_SHARES, random);
}

const baselineSettlement: PaymentModel['settlement'] = (random) => settleBy(BASELINE_SHARES, random);

/** Request time of a provider record: the request is sent `durationMs` before the timeout or the reply. */
function requestMsOf(record: LogRecord): number {
  return Date.parse(record.ts) - record.durationMs;
}

const timeoutLowered: Mechanism = {
  name: 'timeout_lowered',
  kind: 'cause',
  service: 'provider-adapter',
  paymentModel: (changeMs) => ({
    provider: (random, requestMs) => ({
      latencyMs: providerLatency(random),
      timeoutMs: requestMs >= changeMs ? LOWERED_TIMEOUT_MS : BASE_TIMEOUT_MS,
    }),
    settlement: baselineSettlement,
  }),
  // A late reply that the old timeout would have accepted: it fails only because the timeout was lowered.
  isCauseEvidence: (record, changeMs) =>
    record.event === 'provider.response' &&
    record.status === 'late' &&
    requestMsOf(record) >= changeMs &&
    record.durationMs <= BASE_TIMEOUT_MS,
};

const providerSlowed: Mechanism = {
  name: 'provider_slowed',
  kind: 'cause',
  service: 'provider-adapter',
  paymentModel: (changeMs) => ({
    provider: (random, requestMs) => ({
      latencyMs: requestMs >= changeMs ? providerLatency(random, SLOWED_LATENCY_MEAN_EXCESS_MS) : providerLatency(random),
      timeoutMs: BASE_TIMEOUT_MS,
    }),
    settlement: baselineSettlement,
  }),
  isCauseEvidence: (record, changeMs) =>
    record.event === 'provider.response' && record.status === 'late' && requestMsOf(record) >= changeMs,
};

const ledgerWriteErrors: Mechanism = {
  name: 'ledger_write_errors',
  kind: 'cause',
  service: 'ledger',
  paymentModel: (changeMs) => ({
    provider: (random) => ({ latencyMs: providerLatency(random), timeoutMs: BASE_TIMEOUT_MS }),
    settlement: settlementAfter(changeMs, { ...BASELINE_SHARES, ledgerError: RAISED_SHARE }),
  }),
  // `spanSeq > 0`: the ledger span of a payment trace, not a background ledger record.
  isCauseEvidence: (record, changeMs) =>
    record.event === 'ledger.write' &&
    record.status === 'error' &&
    record.spanSeq > 0 &&
    Date.parse(record.ts) >= changeMs,
};

const noCause: Mechanism = {
  name: 'no_cause',
  kind: 'no_cause',
  service: null,
  paymentModel: (changeMs) => ({
    provider: (random) => ({ latencyMs: providerLatency(random), timeoutMs: BASE_TIMEOUT_MS }),
    settlement: settlementAfter(changeMs, { ...BASELINE_SHARES, unexplainedError: RAISED_SHARE }),
  }),
  isCauseEvidence: () => false,
};

/** The catalog of cause mechanisms; a set file names one per scenario. */
export const MECHANISMS: Readonly<Record<MechanismName, Mechanism>> = {
  timeout_lowered: timeoutLowered,
  provider_slowed: providerSlowed,
  ledger_write_errors: ledgerWriteErrors,
  no_cause: noCause,
};
