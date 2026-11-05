import { z } from 'zod';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { RoleMessage, TokenCounter } from '../model/token-counter.js';
import type { EngineLogger } from '../ports.js';
import {
  type ClaimLine,
  type ControllerMaterial,
  controllerMessages,
  newestFirst,
  type RoleSlots,
  slotMessages,
  type WorkerMaterial,
  workerSlots,
} from './role-packets.js';

type RoleConfig = ProcessConfig['roles']['worker'];

/** The role call a packet is built for; `roleConfig` comes from the investigation's configuration. */
export interface PacketFrame {
  readonly roleConfig: Pick<RoleConfig, 'model' | 'effort' | 'windowTokens' | 'marginTokens'>;
  /** The rendered role prompt, sent as `system`. */
  readonly instructions: string;
  readonly outputSchema: z.ZodType;
  readonly signal: AbortSignal;
}

/** A packet that fits: counted input not above `windowTokens − marginTokens` of the role. */
export interface PackedPacket {
  readonly outcome: 'packed';
  readonly system: string;
  readonly messages: readonly RoleMessage[];
  readonly inputTokens: number;
}

/** The count was refused (network or non-2xx); the caller treats it like a provider error. */
export interface CountFailed {
  readonly outcome: 'count_failed';
  readonly statusCode: number | null;
}

/** DC-7: the mandatory material does not fit; nothing was cut and the model is not called. */
export interface NeedsNarrowing {
  readonly outcome: 'needs_narrowing';
  readonly materialTokens: number;
  readonly limitTokens: number;
}

/** DC-8: the mandatory part of the controller input does not fit its window. */
export interface ContextOverflow {
  readonly outcome: 'context_overflow';
  readonly mandatoryTokens: number;
  readonly limitTokens: number;
}

export type SlotPacketResult = PackedPacket | NeedsNarrowing | CountFailed;
export type ControllerPacketResult = PackedPacket | ContextOverflow | CountFailed;

/** Lays role material into slots within the role window (design-engine.md, C3). */
export interface ContextBuilder {
  /** Every slot is mandatory: the packet fits whole or is `needs_narrowing`. */
  buildSlotPacket(frame: PacketFrame, slots: RoleSlots): Promise<SlotPacketResult>;
  buildWorkerPacket(frame: PacketFrame, material: WorkerMaterial): Promise<SlotPacketResult>;
  /** The mandatory part whole, then earlier claims newest first while they fit. */
  buildControllerPacket(
    frame: PacketFrame,
    material: ControllerMaterial,
  ): Promise<ControllerPacketResult>;
}

export interface ContextBuilderDeps {
  readonly tokenCounter: TokenCounter;
  /** A refused count is logged with its status and error class, never with the packet. */
  readonly logger: EngineLogger;
}

type Counted = { readonly outcome: 'counted'; readonly packet: PackedPacket } | CountFailed;

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  /**
   * Counts the packet in the composition of the call itself (KD-4). The packet must leave the margin
   * free, so the counted input stays within `windowTokens` while the provider's drift is within it.
   */
  const count = async (frame: PacketFrame, messages: RoleMessage[]): Promise<Counted> => {
    const counted = await deps.tokenCounter.countInputTokens(
      {
        model: frame.roleConfig.model,
        system: frame.instructions,
        messages,
        effort: frame.roleConfig.effort,
        outputSchema: z.toJSONSchema(frame.outputSchema),
      },
      frame.signal,
    );
    if (counted.outcome === 'failed') {
      deps.logger.warn('token count failed', {
        model: frame.roleConfig.model,
        statusCode: counted.statusCode,
        errorClass: counted.errorClass,
      });
      return { outcome: 'count_failed', statusCode: counted.statusCode };
    }
    return {
      outcome: 'counted',
      packet: {
        outcome: 'packed',
        system: frame.instructions,
        messages,
        inputTokens: counted.inputTokens,
      },
    };
  };

  const limitOf = (frame: PacketFrame): number =>
    frame.roleConfig.windowTokens - frame.roleConfig.marginTokens;

  const buildSlotPacket = async (
    frame: PacketFrame,
    slots: RoleSlots,
  ): Promise<SlotPacketResult> => {
    const counted = await count(frame, slotMessages(slots));
    if (counted.outcome === 'count_failed') return counted;
    const limitTokens = limitOf(frame);
    if (counted.packet.inputTokens > limitTokens) {
      return { outcome: 'needs_narrowing', materialTokens: counted.packet.inputTokens, limitTokens };
    }
    return counted.packet;
  };

  /**
   * The largest newest-first prefix of earlier claims that fits. The count grows with the prefix, so a
   * binary search needs O(log n) counts; `fitting` is the packet of a prefix known to fit.
   */
  const packEarlierClaims = async (
    frame: PacketFrame,
    material: ControllerMaterial,
    fitting: PackedPacket,
  ): Promise<ControllerPacketResult> => {
    const claims: ClaimLine[] = newestFirst(material.claims);
    const limitTokens = limitOf(frame);
    let best = fitting;
    let low = 0;
    let high = claims.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const counted = await count(frame, controllerMessages(material, claims.slice(0, middle)));
      if (counted.outcome === 'count_failed') return counted;
      if (counted.packet.inputTokens <= limitTokens) {
        best = counted.packet;
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return best;
  };

  return {
    buildSlotPacket,
    buildWorkerPacket: (frame, material) => buildSlotPacket(frame, workerSlots(material)),
    async buildControllerPacket(frame, material) {
      const mandatory = await count(frame, controllerMessages(material, []));
      if (mandatory.outcome === 'count_failed') return mandatory;
      const limitTokens = limitOf(frame);
      if (mandatory.packet.inputTokens > limitTokens) {
        return {
          outcome: 'context_overflow',
          mandatoryTokens: mandatory.packet.inputTokens,
          limitTokens,
        };
      }
      return packEarlierClaims(frame, material, mandatory.packet);
    },
  };
}
