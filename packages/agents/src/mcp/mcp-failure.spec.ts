import {
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { type McpFailure, mcpFailureReason } from './mcp-failure';

// DC-10, KD-5 (map), UC-E4 (class): every MCP client error maps to its own outcome and reason;
// an error outside the known classes is a defect and propagates.

function abortedSignalReason(): unknown {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason;
}

const authRetryFailed = new SdkHttpError(
  SdkErrorCode.ClientHttpAuthentication,
  'Server returned 401 after re-authentication',
  { status: 401 },
);

describe('an MCP client error maps to its outcome and reason', () => {
  it.each([
    [
      'a 401 without a refresh hook, personal OAuth',
      new UnauthorizedError(),
      'oauth',
      { kind: 'auth_required' },
    ],
    [
      'a 401 without a refresh hook, shared token',
      new UnauthorizedError(),
      'shared',
      { kind: 'failure', reason: 'unauthorized' },
    ],
    [
      'a 401 after the refresh, personal OAuth',
      authRetryFailed,
      'oauth',
      { kind: 'auth_required' },
    ],
    [
      'a 401 after the refresh, shared token',
      authRetryFailed,
      'shared',
      { kind: 'failure', reason: 'unauthorized' },
    ],
    [
      'a refused connection',
      new TypeError('fetch failed'),
      'shared',
      { kind: 'failure', reason: 'connection_lost' },
    ],
    [
      'a body cut mid-read',
      new TypeError('terminated'),
      'oauth',
      { kind: 'failure', reason: 'connection_lost' },
    ],
    [
      'a request timeout',
      new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'),
      'shared',
      { kind: 'failure', reason: 'timeout' },
    ],
    [
      'an aborted step signal',
      abortedSignalReason(),
      'shared',
      { kind: 'failure', reason: 'timeout' },
    ],
    [
      'a JSON-RPC error of the server',
      new ProtocolError(ProtocolErrorCode.InternalError, 'boom'),
      'shared',
      { kind: 'failure', reason: 'protocol_error' },
    ],
    [
      'an unreadable response body',
      new SyntaxError('Unexpected token < in JSON'),
      'shared',
      { kind: 'failure', reason: 'protocol_error' },
    ],
    [
      'an OAuth error of the authorization server on a token refresh',
      new OAuthError(
        OAuthErrorCode.ServerError,
        'HTTP 500: Invalid OAuth error response',
      ),
      'oauth',
      { kind: 'failure', reason: 'protocol_error' },
    ],
    [
      'an unexpected content type',
      new SdkError(
        SdkErrorCode.ClientHttpUnexpectedContent,
        'Unexpected content type: text/html',
      ),
      'shared',
      { kind: 'failure', reason: 'protocol_error' },
    ],
  ] as const)('%s', (_case, error, mode, expected: McpFailure) => {
    expect(mcpFailureReason(error, mode)).toEqual(expected);
  });

  it.each([
    ['an error outside the client classes', new Error('a bug')],
    [
      'a TypeError that is not a fetch failure',
      new TypeError('client.callTool is not a function'),
    ],
  ])('%s propagates as a defect', (_case, error) => {
    expect(() => mcpFailureReason(error, 'shared')).toThrow(error);
  });
});
