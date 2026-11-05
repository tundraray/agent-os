import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { classifyMcpError } from './mcp-error-classifier.js';
import { McpStartupError } from './mcp-startup-error.js';

// design-mcp-source.md, Error Handling: rows K-3…K-9 and K-13 of the classification table; K-14 is rethrown.
describe('classifyMcpError', () => {
  it.each([
    ['K-3 -32602 invalid params', new ProtocolError(-32602, 'Tool x not found'), 'config_or_protocol_mismatch', false, false, 'K-3'],
    ['K-3 -32600 invalid request', new ProtocolError(-32600, 'bad'), 'config_or_protocol_mismatch', false, false, 'K-3'],
    ['K-4 -32603 internal error', new ProtocolError(-32603, 'boom'), 'server_internal_error', true, false, 'K-4'],
    ['K-4 -32700 parse error', new ProtocolError(-32700, 'parse'), 'protocol_error', true, false, 'K-4'],
    ['K-4 any other code', new ProtocolError(-32099, 'custom'), 'protocol_error', true, false, 'K-4'],
    ['K-5 ConnectionClosed', new SdkError(SdkErrorCode.ConnectionClosed, 'closed'), 'connection_lost', true, true, 'K-5'],
    ['K-5 NotConnected', new SdkError(SdkErrorCode.NotConnected, 'nc'), 'connection_lost', true, true, 'K-5'],
    ['K-5 SendFailed', new SdkError(SdkErrorCode.SendFailed, 'sf'), 'connection_lost', true, true, 'K-5'],
    ['K-6 RequestTimeout', new SdkError(SdkErrorCode.RequestTimeout, 'timeout'), 'timeout', true, false, 'K-6'],
    ['K-7 InvalidResult', new SdkError(SdkErrorCode.InvalidResult, 'invalid'), 'invalid_result', true, false, 'K-7'],
    ['K-8 HTTP 503', new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'down', { status: 503 }), 'http_status', true, false, 'K-8'],
    ['K-8 HTTP 429', new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'slow down', { status: 429 }), 'http_status', true, false, 'K-8'],
    ['K-8 HTTP 408', new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'timeout', { status: 408 }), 'http_status', true, false, 'K-8'],
    ['K-9 CapabilityNotSupported', new SdkError(SdkErrorCode.CapabilityNotSupported, 'cap'), 'config_or_protocol_mismatch', false, false, 'K-9'],
    ['K-9 EraNegotiationFailed', new SdkError(SdkErrorCode.EraNegotiationFailed, 'era'), 'config_or_protocol_mismatch', false, false, 'K-9'],
    ['K-9 HTTP 401', new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'auth', { status: 401 }), 'config_or_protocol_mismatch', false, false, 'K-9'],
    ['K-9 other 4xx', new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'gone', { status: 404 }), 'config_or_protocol_mismatch', false, false, 'K-9'],
    ['K-9 tagged start() failure (plain Error)', new McpStartupError(new Error('spawn node ENOENT')), 'config_or_protocol_mismatch', false, false, 'K-9'],
    ['K-13 unknown SdkError code', new SdkError('SOME_CODE_NEWER_THAN_2_4_0' as SdkErrorCode, 'new'), 'unclassified_client_error', false, false, 'K-13'],
    ['K-13 AlreadyConnected', new SdkError(SdkErrorCode.AlreadyConnected, 'again'), 'unclassified_client_error', false, false, 'K-13'],
  ] as const)('%s', (_row, error, code, retryable, reconnect, cause) => {
    expect(classifyMcpError(error)).toEqual({
      kind: 'transport',
      failureClass: 'transport_protocol',
      code,
      retryable,
      reconnect,
      cause,
    });
  });

  it('K-14 rethrows an exception that does not come from the SDK', () => {
    const defect = new TypeError('cannot read properties of undefined');

    expect(() => classifyMcpError(defect)).toThrow(defect);
  });
});
