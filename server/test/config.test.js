import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, scanEnvFile } from '../src/envCheck.js';
import { cleanToken, tokenFingerprint } from '../src/ownerToken.js';

const good = { JWT_SECRET: 'a'.repeat(48), MONGODB_URI: 'mongodb://127.0.0.1:27017/x', OWNER_SETUP_TOKEN: 'b'.repeat(64), SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcdabcdabcdabcd' };

test('valid configuration passes without errors', () => assert.deepEqual(validateEnv(good).errors, []));
test('missing or short JWT_SECRET and missing MONGODB_URI are errors', () => {
  const e = validateEnv({ ...good, JWT_SECRET: 'short', MONGODB_URI: '' }).errors.join(' ');
  assert.match(e, /JWT_SECRET/); assert.match(e, /MONGODB_URI/);
});
test('example secrets are warnings in development but errors in production', () => {
  const env = { ...good, JWT_SECRET: 'replace-with-a-random-secret-at-least-32-characters-long' };
  assert.equal(validateEnv(env).errors.length, 0);
  assert.ok(validateEnv(env).warnings.some(w => /JWT_SECRET/.test(w)));
  assert.ok(validateEnv({ ...env, NODE_ENV: 'production', CLIENT_URL: 'https://x.com' }).errors.some(w => /JWT_SECRET/.test(w)));
});
test('bad SMTP_SENDERS_JSON and unknown provider are errors', () => {
  assert.ok(validateEnv({ ...good, SMTP_SENDERS_JSON: '{oops' }).errors.some(e => /SMTP_SENDERS_JSON/.test(e)));
  assert.ok(validateEnv({ ...good, EMAIL_PROVIDER: 'carrier-pigeon' }).errors.some(e => /EMAIL_PROVIDER/.test(e)));
});
test('.env scan finds duplicate keys and quoted tokens', () => {
  const issues = scanEnvFile('A=1\nOWNER_SETUP_TOKEN="abc"\nA=2\nnot a pair\n# c\n');
  assert.ok(issues.some(i => /A is defined more than once/.test(i)));
  assert.ok(issues.some(i => /quotes/.test(i)));
  assert.ok(issues.some(i => /not KEY=value/.test(i)));
});
test('cleanToken strips pasted prefix, quotes and whitespace', () => {
  const t = 'c'.repeat(64);
  for (const v of [t, ` ${t}\n`, `OWNER_SETUP_TOKEN=${t}`, `"${t}"`, `OWNER_SETUP_TOKEN="${t}"`]) assert.equal(cleanToken(v), t);
  assert.equal(cleanToken(undefined), '');
  assert.notEqual(tokenFingerprint(t), tokenFingerprint(t + 'x'));
  assert.equal(tokenFingerprint(t).length, 6);
});
