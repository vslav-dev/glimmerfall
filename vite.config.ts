import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import changelog from './changelog.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

/** Releases the update notice lists at most: enough for anyone who skipped a few. */
const NOTICE_RELEASES = 20;

/**
 * Serves `version.json`: the live version and what the latest releases changed. The game polls it to notice
 * an update. A static file, revalidated with a conditional GET (304 while unchanged): the server does nothing else.
 * The build fails when the version has no changelog entry, so every release says what it changed.
 */
function versionFile(): Plugin {
  const source = (): string => JSON.stringify({ version: pkg.version, releases: changelog.slice(0, NOTICE_RELEASES) });
  return {
    name: 'version-file',
    buildStart() {
      if (changelog[0]?.version !== pkg.version) this.error(`changelog.json has no entry for ${pkg.version} on top`);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: source() });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(source());
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [versionFile()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // 4213: next free port in the 42xx series the other local projects use.
  server: { port: 4213, strictPort: true, host: true },
  preview: { port: 4213, strictPort: true, host: true },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
