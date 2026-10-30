// Shared integration-test harness: throwaway database, in-process server, tiny HTTP client.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

function boot(overrides = {}) {
  const dbName = `unichat_test_${crypto.randomBytes(6).toString('hex')}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', PORT: '0', MONGODB_URI: `mongodb://127.0.0.1:27017/${dbName}`,
    JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
    AUTO_JOIN_DEFAULT_WORKSPACE: 'false', REQUIRE_EMAIL_VERIFICATION: 'false', EMAIL_TRANSPORT: 'file', FILE_STORAGE: 'local',
    ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', REDIS_URL: '', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
  let base; let counter = 0;
  const ctx = {
    async start() {
      const { io, startServer } = require('../../src/index');
      await startServer();
      ctx.io = io;
      ctx.port = io.httpServer.address().port;
      base = `http://127.0.0.1:${ctx.port}/api`;
      process.env.PUBLIC_API_URL = base;
    },
    async call(route, { method = 'GET', body, token, headers = {} } = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++counter % 250 + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
    },
    ok(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; },
    async register(name) {
      const body = ctx.ok(await ctx.call('/auth/register', { method: 'POST', body: { email: `${name}@example.test`, username: name, displayName: name, password: 'A memorable test passphrase 42!' } }), 201);
      return { id: body.user._id, token: body.accessToken, refreshToken: body.refreshToken, name };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async finish(code) {
      try { await mongoose.connection.dropDatabase(); } catch { /* nothing to drop */ }
      process.exit(code);
    },
    async main(run) {
      setTimeout(() => { console.error('Test timed out after 240s'); process.exit(2); }, 240000).unref();
      try { await ctx.start(); await run(ctx); console.log('all tests passed'); await ctx.finish(0); }
      catch (error) { console.error(error); await ctx.finish(1); }
    },
  };
  return ctx;
}
module.exports = { boot, assert };
