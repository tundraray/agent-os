/** Result of the address rule; `insecure_url` is the reason of a failed server check. */
export type ServerUrlCheck = 'ok' | 'insecure_url';

export interface ServerUrlRule {
  /** Development only: plain `http` is accepted too (`http://localhost` servers and fixtures). */
  readonly allowHttp: boolean;
}

/**
 * The rule for an MCP server address and the addresses from its authorization-server metadata
 * (Security Considerations): `https` always, `http` only when allowed, anything else never.
 */
export function checkServerUrl(
  url: string | URL,
  rule: ServerUrlRule,
): ServerUrlCheck {
  if (!URL.canParse(url)) {
    return 'insecure_url';
  }
  const { protocol } = new URL(url);
  if (protocol === 'https:' || (protocol === 'http:' && rule.allowHttp)) {
    return 'ok';
  }
  return 'insecure_url';
}
