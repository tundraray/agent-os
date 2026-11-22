import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  isJSONRPCRequest,
  requireBearerAuth,
  type JSONRPCRequest,
} from '@modelcontextprotocol/server';
import { CallLog } from '../call-log';
import { argsHash } from '../canonical-json';
import type { LogDataset } from '../dataset';
import {
  FaultSchedule,
  isResultFault,
  type FaultRule,
  type ResultFaultRule,
} from '../fault-schedule';
import {
  FixtureServer,
  FixtureSourceSchema,
  type FixtureSource,
} from '../fixture-server';
import { FixtureAuthorizationServer } from './authorization-server';
import { handleControl, type ControlTargets } from './controls';
import { answerWithFault, type HttpAnswer } from './http-faults';

/**
 * The constant bearer token of every `/<source>/mcp` path. A fixture constant for development and tests,
 * not a secret.
 */
export const FIXTURE_SHARED_TOKEN = 'agent-os-fixture-shared-token';

/** `/<source>/mcp` (shared token) and `/<source>/oauth/mcp` (tokens of the fixture's authorization server). */
const MCP_PATH = /^\/(logs|backoffice|tracker)\/(oauth\/)?mcp$/;
const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';
const CONTROL_PREFIX = '/_control/';

export interface FixtureHttpOptions {
  dataset: LogDataset;
  /** `FIXTURE_CALL_LOG`: every `tools/call` is logged; without it nothing is logged and no fault applies. */
  callLogPath?: string;
  /** `FIXTURE_FAULTS`: re-read on every `tools/call`, so a test can change the rules mid-run. */
  faultsPath?: string;
  /** `/_control/*` answers; false under `NODE_ENV=production` (404). */
  controlsEnabled: boolean;
}

/** Who made a `tools/call`, as the call log stores it. */
interface Caller {
  account: string;
  tokenId: number | null;
}

/**
 * One fixture process over HTTP: the three sources at their two paths each, the fixture's authorization
 * server and the test controls. Every MCP request gets its own sessionless transport (`FixtureServer.handleHttp`).
 */
export function createFixtureHttpServer(options: FixtureHttpOptions): Server {
  const sources = Object.fromEntries(
    FixtureSourceSchema.options.map((source) => [
      source,
      new FixtureServer(options.dataset, source),
    ]),
  ) as Record<FixtureSource, FixtureServer>;
  const targets: ControlTargets = {
    auth: new FixtureAuthorizationServer(),
    sources,
    revokedShared: new Set(),
  };
  const log =
    options.callLogPath === undefined
      ? undefined
      : new CallLog(options.callLogPath);

  const route = async (request: Request): Promise<HttpAnswer> => {
    const url = new URL(request.url);
    const issuer = url.origin;
    const path = url.pathname;
    if (path.startsWith(CONTROL_PREFIX)) {
      return options.controlsEnabled
        ? handleControl(request, path.slice(CONTROL_PREFIX.length), targets)
        : new Response(null, { status: 404 });
    }
    if (path.startsWith(`${PROTECTED_RESOURCE_PREFIX}/`)) {
      return protectedResourceMetadata(
        path.slice(PROTECTED_RESOURCE_PREFIX.length),
        issuer,
      );
    }
    const authAnswer = await targets.auth.handle(request, path, issuer);
    if (authAnswer !== undefined) {
      return authAnswer;
    }
    const match = MCP_PATH.exec(path);
    if (match === null) {
      return new Response(null, { status: 404 });
    }
    const source = FixtureSourceSchema.parse(match[1]);
    const caller =
      match[2] === undefined
        ? sharedCaller(request, source, targets.revokedShared)
        : await oauthCaller(
            request,
            `${issuer}${PROTECTED_RESOURCE_PREFIX}${path}`,
            targets.auth,
          );
    if (caller instanceof Response) {
      return caller;
    }
    return serveMcp(request, sources[source], {
      source,
      caller,
      log,
      faultsPath: options.faultsPath,
    });
  };

  return createServer((req, res) => {
    void toRequest(req)
      .then(route)
      .then((answer) => writeAnswer(answer, req, res))
      .catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end(
          `fixture error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });
}

/** RFC 9728 metadata, only for the OAuth paths: the shared-token paths declare no OAuth at all. */
function protectedResourceMetadata(
  resourcePath: string,
  issuer: string,
): Response {
  const match = MCP_PATH.exec(resourcePath);
  if (match === null || match[2] === undefined) {
    return new Response(null, { status: 404 });
  }
  return Response.json({
    resource: `${issuer}${resourcePath}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  });
}

/** The shared token while the source's token is not revoked; 401 without OAuth metadata otherwise. */
function sharedCaller(
  request: Request,
  source: FixtureSource,
  revoked: ReadonlySet<FixtureSource>,
): Caller | Response {
  if (
    request.headers.get('authorization') === `Bearer ${FIXTURE_SHARED_TOKEN}` &&
    !revoked.has(source)
  ) {
    return { account: 'shared', tokenId: null };
  }
  return Response.json(
    {
      error: 'invalid_token',
      error_description: 'missing, wrong or revoked shared token',
    },
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    },
  );
}

/** A live token of the fixture's authorization server; 401 with `resource_metadata` otherwise. */
async function oauthCaller(
  request: Request,
  resourceMetadataUrl: string,
  auth: FixtureAuthorizationServer,
): Promise<Caller | Response> {
  const authInfo = await requireBearerAuth({
    verifier: auth,
    resourceMetadataUrl,
  })(request);
  if (authInfo instanceof Response) {
    return authInfo;
  }
  const { account, tokenId } = authInfo.extra ?? {};
  if (typeof account !== 'string' || typeof tokenId !== 'number') {
    throw new Error('fixture token verifier returned no account or token id');
  }
  return { account, tokenId };
}

interface McpContext {
  source: FixtureSource;
  caller: Caller;
  log: CallLog | undefined;
  faultsPath: string | undefined;
}

/** Logs a `tools/call` with its caller before the server sees it, and applies the matching fault rule. */
async function serveMcp(
  request: Request,
  server: FixtureServer,
  context: McpContext,
): Promise<HttpAnswer> {
  const parsedBody: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  const call =
    isJSONRPCRequest(parsedBody) && parsedBody.method === 'tools/call'
      ? parsedBody
      : undefined;
  const fault =
    call === undefined || context.log === undefined
      ? undefined
      : logCall(call, context.log, context);
  const serve = (resultFault?: ResultFaultRule) =>
    server.handleHttp(request, { parsedBody, resultFault });
  if (fault === undefined) {
    return serve();
  }
  if (isResultFault(fault)) {
    return serve(fault);
  }
  return answerWithFault(fault, (call as JSONRPCRequest).id, () => serve());
}

function logCall(
  request: JSONRPCRequest,
  log: CallLog,
  context: McpContext,
): FaultRule | undefined {
  const params: Record<string, unknown> = request.params ?? {};
  const tool = typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params.arguments) ? params.arguments : {};
  const schedule =
    context.faultsPath === undefined
      ? FaultSchedule.empty()
      : FaultSchedule.fromFile(context.faultsPath);
  const call = {
    source: context.source,
    ...context.caller,
    tool,
    argsHash: argsHash(args),
  };
  return log.record(call, (occurrence) =>
    schedule.match({ tool, argsHash: call.argsHash, occurrence }),
  );
}

/** A `node:http` request as a web `Request`, its body read in full. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value]) {
      headers.append(name, one);
    }
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0;
  return new Request(
    `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`,
    {
      method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    },
  );
}

async function writeAnswer(
  answer: HttpAnswer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (answer === 'hang') {
    return;
  }
  if (answer === 'drop') {
    req.socket.destroy();
    return;
  }
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (answer.body !== null) {
    for await (const chunk of answer.body) {
      res.write(chunk);
    }
  }
  res.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
