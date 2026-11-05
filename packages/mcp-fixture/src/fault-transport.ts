import type { Readable, Writable } from 'node:stream';
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { CallLog } from './call-log.js';
import { argsHash } from './canonical-json.js';
import {
  isResultFault,
  type FaultRule,
  type FaultSchedule,
  type ResultFaultRule,
  type TransportFaultRule,
} from './fault-schedule.js';

/** Transport faults that let the server answer and then replace or hold back its response. */
type ResponseFaultRule = Exclude<TransportFaultRule, { mode: 'drop_connection' | 'crash_process' | 'hang' }>;

const MALFORMED_LINE = 'fixture fault: this line is not JSON\n';

export interface FaultTransportOptions {
  schedule: FaultSchedule;
  log: CallLog;
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Stdio transport that logs every `tools/call` to the call log before the server sees it and applies the
 * matching fault rule: transport modes act here (by request `id`), result modes are handed to the server through
 * {@link FaultTransport.takeResultFault}. Other messages pass through untouched.
 */
export class FaultTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private readonly stdout: Writable;
  private readonly inner: StdioServerTransport;
  private readonly responseFaults = new Map<RequestId, ResponseFaultRule>();
  private readonly resultFaults = new Map<RequestId, ResultFaultRule>();

  constructor(private readonly options: FaultTransportOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.inner = new StdioServerTransport(options.stdin ?? process.stdin, this.stdout);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => this.receive(message);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
      const fault = this.responseFaults.get(message.id);
      if (fault !== undefined) {
        this.responseFaults.delete(message.id);
        return this.sendFaulty(message.id, message, fault);
      }
    }
    return this.inner.send(message);
  }

  /** The result fault of the `tools/call` request with this `id`, removed once taken. */
  takeResultFault(id: RequestId): ResultFaultRule | undefined {
    const fault = this.resultFaults.get(id);
    this.resultFaults.delete(id);
    return fault;
  }

  private receive(message: JSONRPCMessage): void {
    if (!isJSONRPCRequest(message) || message.method !== 'tools/call') {
      this.onmessage?.(message);
      return;
    }
    const fault = this.logCall(message);
    if (fault === undefined) {
      this.onmessage?.(message);
      return;
    }
    if (isResultFault(fault)) {
      this.resultFaults.set(message.id, fault);
      this.onmessage?.(message);
      return;
    }
    switch (fault.mode) {
      case 'crash_process':
        process.exit(1);
        break;
      case 'drop_connection':
        void this.inner.close().finally(() => process.exit(0));
        break;
      case 'hang':
        // The request never reaches the server, so no response and no reaction to cancellation.
        break;
      default:
        this.responseFaults.set(message.id, fault);
        this.onmessage?.(message);
    }
  }

  private logCall(request: JSONRPCRequest): FaultRule | undefined {
    const params: Record<string, unknown> = request.params ?? {};
    const tool = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const call = { tool, argsHash: argsHash(args) };
    return this.options.log.record(call, (occurrence) => this.options.schedule.match({ ...call, occurrence }));
  }

  private sendFaulty(id: RequestId, response: JSONRPCMessage, fault: ResponseFaultRule): Promise<void> {
    switch (fault.mode) {
      case 'late_response':
        setTimeout(() => {
          this.inner.send(response).catch((error: unknown) => this.onerror?.(toError(error)));
        }, fault.ms);
        return Promise.resolve();
      case 'jsonrpc_error':
        return this.inner.send({
          jsonrpc: '2.0',
          id,
          error: { code: fault.code, message: fault.message ?? `fixture fault: JSON-RPC error ${fault.code}` },
        });
      case 'invalid_result':
        // `content` must be an array of content blocks, so the client's `CallToolResult` schema rejects this.
        return this.inner.send({ jsonrpc: '2.0', id, result: { content: 'not a content array' } });
      case 'malformed_json':
        return new Promise((resolve, reject) => {
          this.stdout.write(MALFORMED_LINE, (error) => (error ? reject(error) : resolve()));
        });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
