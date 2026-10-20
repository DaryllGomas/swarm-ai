// Tests run inside workerd (the real Workers runtime) with a local D1 database; the migrations are applied for real.
// No network and no deploy token needed: `npm test`.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        main: './src/worker.js',
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['MIG_DB'], // a scratch database for the migration upgrade tests (the tests build it from the migrations)
          compatibilityDate: '2026-08-15', // the test runtime (workerd bundled with the pool) is older than production's date
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: 'test-admin-token-0123456789',
            HASH_SALT: 'test-hash-salt-0123456789',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.js'],
      fileParallelism: false, // the files share one local D1 database
      setupFiles: ['./test/apply-migrations.js'],
    },
  };
});
