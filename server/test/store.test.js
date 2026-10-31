import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

// Minimal in-memory stand-in for the Mongoose model (find / bulkWrite) so the diff logic can be tested without MongoDB.
function fakeModel() {
  const docs = new Map(); const writes = []; let failNext = false;
  const key = f => `${f.kind}:${f.itemId}`;
  return {
    docs, writes,
    failOnce() { failNext = true; },
    find: () => ({ lean: async () => [...docs.values()].map(d => JSON.parse(JSON.stringify(d, (k, v) => (k === 'blob' ? undefined : v))) ).map((d, i) => { const orig = [...docs.values()][i]; if (orig.blob) d.blob = orig.blob; return d; }) }),
    bulkWrite: async ops => {
      if (failNext) { failNext = false; throw new Error('mongo down'); }
      for (const op of ops) {
        if (op.replaceOne) { docs.set(key(op.replaceOne.filter), { ...op.replaceOne.replacement }); writes.push(['put', key(op.replaceOne.filter)]); }
        if (op.deleteOne) { docs.delete(key(op.deleteOne.filter)); writes.push(['del', key(op.deleteOne.filter)]); }
      }
    }
  };
}
const silent = { error() {}, log() {}, warn() {} };
const defaults = () => ({ recipients: [{ id: 'r1', email: 'a@x.com' }], campaigns: [{ id: 'c1', name: 'First' }], activity: [], templates: [], settings: {} });
const bindState = (store, s) => store.bind({ get recipients() { return s.recipients; }, get campaigns() { return s.campaigns; }, get activity() { return s.activity; }, get templates() { return s.templates; }, settings: () => s.settings });

test('first start writes defaults, second start reloads them in the same order', async () => {
  const model = fakeModel();
  const s1 = createStore({ model, logger: silent });
  const st = await s1.load({ defaults });
  assert.equal(st.source, 'defaults');
  bindState(s1, st); await s1.flush();

  st.recipients.unshift({ id: 'r2', email: 'b@x.com' }); // newest first, like the API does
  await s1.flush();

  const s2 = createStore({ model, logger: silent });
  const again = await s2.load({ defaults });
  assert.equal(again.source, 'mongodb');
  assert.deepEqual(again.recipients.map(r => r.id), ['r2', 'r1']);
});

test('only changed documents are written, and removed ones are deleted', async () => {
  const model = fakeModel(); const store = createStore({ model, logger: silent });
  const st = await store.load({ defaults }); bindState(store, st); await store.flush();
  model.writes.length = 0;

  await store.flush();
  assert.equal(model.writes.length, 0, 'no changes -> no writes');

  st.recipients[0].status = 'Subscribed'; await store.flush();
  assert.deepEqual(model.writes.filter(w => w[1].startsWith('recipient')), [['put', 'recipient:r1']]);

  model.writes.length = 0; st.recipients.splice(0, 1); await store.flush();
  assert.ok(model.writes.some(w => w[0] === 'del' && w[1] === 'recipient:r1'));
  assert.equal(model.docs.has('recipient:r1'), false);
});

test('a failed save is retried and nothing is marked as saved', async () => {
  const model = fakeModel(); const store = createStore({ model, logger: silent });
  const st = await store.load({ defaults }); bindState(store, st);
  model.failOnce(); await store.flush();
  assert.equal(store.status().ok, false);
  assert.equal(model.docs.size, 0);
  await store.flush();                       // next attempt succeeds and writes everything
  assert.equal(store.status().ok, true);
  assert.ok(model.docs.has('recipient:r1'));
});

test('campaign attachments are stored separately and restored as Buffers', async () => {
  const model = fakeModel(); const s1 = createStore({ model, logger: silent });
  const st = await s1.load({ defaults }); bindState(s1, st);
  st.campaigns[0].attachment = { filename: 'a.pdf', mimetype: 'application/pdf', size: 5, buffer: Buffer.from('%PDF-') };
  await s1.flush();
  assert.ok(!('attachment' in model.docs.get('campaign:c1').data) || !model.docs.get('campaign:c1').data.attachment.buffer, 'bytes are not inside the campaign doc');

  const s2 = createStore({ model, logger: silent }); const again = await s2.load({ defaults });
  assert.equal(again.campaigns[0].attachment.filename, 'a.pdf');
  assert.equal(again.campaigns[0].attachment.buffer.toString(), '%PDF-');

  bindState(s2, again); delete again.campaigns[0].attachment; await s2.flush();
  assert.equal(model.docs.has('attachment:c1'), false);
});

test('legacy data.json is imported (with attachment) when MongoDB is empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-')); const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({ recipients: [{ id: 'x', email: 'x@y.com' }], campaigns: [{ id: 'k', name: 'Old', attachment: { filename: 'f.pdf', mimetype: 'application/pdf', size: 5, bufferBase64: Buffer.from('%PDF-').toString('base64') } }], activity: [], templates: [], settings: { fromName: 'Me' } }));
  const model = fakeModel(); const store = createStore({ model, logger: silent });
  const st = await store.load({ legacyFile: file, defaults });
  assert.equal(st.source, 'legacy-json');
  assert.equal(st.campaigns[0].attachment.buffer.toString(), '%PDF-');
  bindState(store, st); await store.flush();
  assert.ok(model.docs.has('recipient:x') && model.docs.has('attachment:k'));
  assert.equal(model.docs.get('singleton:settings').data.fromName, 'Me');
});

test('a corrupt data.json is backed up and sample data is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-')); const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{ not json');
  const store = createStore({ model: fakeModel(), logger: silent });
  const st = await store.load({ legacyFile: file, defaults });
  assert.equal(st.source, 'defaults');
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('data.json.corrupt-')));
});

test('large lists are written in chunks', async () => {
  const model = fakeModel(); const store = createStore({ model, logger: silent });
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}`, email: `u${i}@x.com` }));
  const st = { recipients: many, campaigns: [], activity: [], templates: [], settings: {}, source: 'defaults' };
  bindState(store, st); await store.flush();
  assert.equal([...model.docs.keys()].filter(k => k.startsWith('recipient:')).length, 2500);
});
