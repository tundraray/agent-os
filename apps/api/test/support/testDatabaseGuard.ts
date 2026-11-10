const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Refuses a server that does not look like the local test one: a harness that creates and drops databases runs only
 * against a local host on the dev test port 5433, or the CI database `agent_os`, or a name containing `test`.
 */
export function assertTestDatabase(url: string, harness: string): void {
  const { hostname, port, pathname } = new URL(url);
  const name = pathname.slice(1);
  if (
    LOCAL_HOSTS.includes(hostname) &&
    (port === '5433' || name === 'agent_os' || name.includes('test'))
  ) {
    return;
  }
  throw new Error(
    `Refusing to create or drop databases on ${hostname}:${port || '5432'}/${name}: ` +
      `the ${harness} runs only against a local test server (port 5433, or database agent_os or *test*)`,
  );
}
