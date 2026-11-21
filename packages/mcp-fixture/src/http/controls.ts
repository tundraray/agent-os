import { z } from 'zod';
import { FixtureSourceSchema, type FixtureServer, type FixtureSource } from '../fixture-server';
import { defineTool } from '../tools/fixture-tool';
import type { FixtureAuthorizationServer } from './authorization-server';

/** What the test controls change: the authorization server, the sources and the shared token per source. */
export interface ControlTargets {
  readonly auth: FixtureAuthorizationServer;
  readonly sources: Readonly<Record<FixtureSource, FixtureServer>>;
  readonly revokedShared: Set<FixtureSource>;
}

const TokenLifetimeSchema = z.strictObject({ seconds: z.int().min(1) });
const RevokeSchema = z.strictObject({ account: z.string().min(1), which: z.enum(['access', 'refresh', 'all']) });
const RevokeSharedSchema = z.strictObject({ source: FixtureSourceSchema });
const AddToolSchema = z.strictObject({ source: FixtureSourceSchema, name: z.string().min(1) });
const HoldRefreshSchema = z.strictObject({ account: z.string().min(1), path: z.string().min(1).optional() });

/**
 * Test controls under `/_control/<name>` (the HTTP server hides them under `NODE_ENV=production`).
 * `stats` answers `GET` (`?account=` for one account); the others take a JSON body and answer 204.
 */
export async function handleControl(request: Request, name: string, targets: ControlTargets): Promise<Response> {
  if (name === 'stats') {
    const account = new URL(request.url).searchParams.get('account');
    return Response.json(account === null ? targets.auth.stats() : targets.auth.stats(account));
  }
  const body: unknown = await request.json().catch(() => undefined);
  try {
    switch (name) {
      case 'token-lifetime':
        targets.auth.setTokenLifetime(TokenLifetimeSchema.parse(body).seconds);
        break;
      case 'revoke': {
        const { account, which } = RevokeSchema.parse(body);
        targets.auth.revoke(account, which);
        break;
      }
      case 'revoke-shared':
        targets.revokedShared.add(RevokeSharedSchema.parse(body).source);
        break;
      case 'add-tool': {
        const { source, name: toolName } = AddToolSchema.parse(body);
        targets.sources[source].addTool(addedTool(toolName));
        break;
      }
      case 'hold-refresh': {
        const { account, path } = HoldRefreshSchema.parse(body);
        targets.auth.holdRefresh(account, path);
        break;
      }
      default:
        return new Response(`unknown control: ${name}`, { status: 404 });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(`invalid ${name} body: ${z.prettifyError(error)}`, { status: 400 });
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}

/** A reading tool without arguments that a test adds to a source's `tools/list`. */
function addedTool(name: string) {
  return defineTool({
    name,
    title: name,
    description: `Tool ${name} added by a fixture test control; returns its own name.`,
    readOnly: true,
    argsSchema: z.strictObject({}),
    run: () => ({ tool: name }),
  });
}
