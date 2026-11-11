import {
  FixtureProcess,
  fixtureTool,
  type FixtureSourceAdapterOptions,
  type FixtureTool,
} from '../fixture/fixture-source.adapter.js';
import {
  GetOrderArgsSchema,
  GetOrderResultSchema,
  SearchOrdersArgsSchema,
  SearchOrdersResultSchema,
} from '../fixture/fixture-tools.schema.js';
import type { CallOutcome, SourceAdapter, SourceCall, SourceDescriptor } from '../source-adapter.js';

export const BACKOFFICE_SOURCE_ID = 'backoffice';

/** Units of `Coverage` per tool: an order for `search_orders`, the one order (or none) for `get_order`. */
const BACKOFFICE_TOOLS: readonly FixtureTool[] = [
  fixtureTool({
    name: 'search_orders',
    paginated: true,
    argsSchema: SearchOrdersArgsSchema,
    resultSchema: SearchOrdersResultSchema,
    normalize: (result) => ({
      snapshot: result.snapshot,
      items: result.orders,
      returned: result.orders.length,
      totalMatched: result.totalMatched ?? null,
      totalRelation: result.totalRelation ?? null,
      nextCursor: result.nextCursor,
      exhausted: false,
    }),
  }),
  fixtureTool({
    name: 'get_order',
    paginated: false,
    argsSchema: GetOrderArgsSchema,
    resultSchema: GetOrderResultSchema,
    normalize: (result) => {
      const items = result.order === null ? [] : [result.order];
      return {
        snapshot: result.snapshot,
        items,
        returned: items.length,
        totalMatched: items.length,
        totalRelation: 'eq',
        nextCursor: null,
        exhausted: true,
      };
    },
  }),
];

/**
 * The back-office MCP source (KD-7): a second fixture process in `FIXTURE_SOURCE=backoffice` mode over the same
 * scenario or dataset, rules file and call log as the logs adapter, with the same client, slice and failure
 * accounting. Its descriptor is the project's; the text the server reports is never read.
 */
export class BackofficeSourceAdapter implements SourceAdapter {
  readonly descriptor: SourceDescriptor = {
    sourceId: BACKOFFICE_SOURCE_ID,
    tools: BACKOFFICE_TOOLS.map((tool) => tool.descriptor),
  };
  private readonly process: FixtureProcess;

  constructor(options: FixtureSourceAdapterOptions) {
    this.process = new FixtureProcess('backoffice', BACKOFFICE_TOOLS, options);
  }

  call(call: SourceCall): Promise<CallOutcome> {
    return this.process.call(call);
  }

  currentSnapshot(signal: AbortSignal): Promise<string> {
    return this.process.currentSnapshot(signal);
  }

  close(): Promise<void> {
    return this.process.close();
  }
}
