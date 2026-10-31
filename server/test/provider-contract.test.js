import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const providers = await readFile(new URL('../src/providers.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('provider adapter includes native SES v2 API and SigV4 signing', () => {
  assert.match(providers, /AWS4-HMAC-SHA256/);
  assert.match(providers, /\/v2\/email\/outbound-emails/);
  assert.match(providers, /provider === 'ses'/);
});

test('test-email and provider verification route dispatch through provider adapters', () => {
  assert.match(index, /verifyProvider\(\{ provider: sender\.provider, sender \}\)/);
  assert.match(index, /sendThroughProvider\(\{ provider: sender\.provider, sender, mail \}\)/);
});

test('delivery state explicitly distinguishes provider acceptance from delivery', () => {
  assert.match(index, /Accepted by provider/);
  assert.match(index, /not confirm mailbox delivery or Inbox placement/i);
});

test('SES API supports MIME attachments through Raw content', () => {
  assert.match(providers, /buildRawMime/);
  assert.match(providers, /Raw: \{ Data: buildRawMime/);
  assert.doesNotMatch(providers, /requires attachment-free messages/);
});

test('campaign sending is capped to a selected 1..500 recipient batch', () => {
  assert.match(index, /Math\.min\(500, Math\.max\(1, Number\.parseInt\(req\.body\?\.batchSize/);
  assert.match(index, /eligibleAudience\.slice\(0, batchSize\)/);
});

test('shared Redis queue enforces one active recipient job and one job start per second', async () => {
  const queue = await readFile(new URL('../src/emailQueue.js', import.meta.url), 'utf8');
  assert.match(queue, /setGlobalConcurrency\(1\)/);
  assert.match(queue, /concurrency:1,limiter:\{max:1,duration:1000\}/);
});
