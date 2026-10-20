// Runs before each test file: bring the local D1 database up to the latest migration (the same files production uses).
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
