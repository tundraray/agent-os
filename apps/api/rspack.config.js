import path from 'node:path';

const packages = path.resolve(import.meta.dirname, '../../packages');

/**
 * Additions to the Nest CLI's rspack defaults. The workspace packages (`@agent-os/*`) have no build of
 * their own: their TypeScript source is compiled into this bundle. Every other package stays an import,
 * resolved at run time from `apps/api/node_modules`, so `package.json` lists the packages' third-party
 * dependencies too.
 */
export default (defaults, rspack) => ({
  // Every entry lands flat in `dist/`: the bundled packages find `./migrations` and `./executor/` next to themselves.
  entry: {
    main: './src/main.ts',
    'migrate-cli': './src/runtime/migrate-cli.ts',
    'super-admin-cli': './src/identity/super-admin-cli.ts',
    'seed-mcp-cli': './src/agents/seed-mcp-cli.ts',
    'seed-access-cli': './src/access/seed-access-cli.ts',
    // The code executor is its own process: one plain file in its own directory, the only one it may read.
    'executor/executor-main': path.join(packages, 'code-runner/src/executor/executor-main.ts'),
  },
  output: { ...defaults.output, filename: '[name].js' },
  externals: [
    ({ request }, callback) => {
      const bundled = /^[.#]/.test(request) || path.isAbsolute(request) || request.startsWith('@agent-os/');
      // `module-import` keeps a static import static and a dynamic `import()` lazy.
      return bundled ? callback() : callback(null, `module-import ${request}`);
    },
  ],
  module: {
    ...defaults.module,
    // `import.meta.url` stays the address of the running file, and `new URL(..., import.meta.url)` is not an asset.
    parser: { javascript: { importMeta: false, url: false } },
  },
  plugins: [
    ...defaults.plugins,
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.join(packages, 'db/src/migrations'), to: 'migrations' }],
    }),
  ],
});
