// MongoDB-backed durable store for campaigns, recipients, templates, activity and settings.
//
// The API still works on in-memory arrays (fast, simple route handlers), but every change is
// now written to MongoDB (diff-based: only changed documents are written) instead of the old
// server/data.json file. A crash or restart therefore loses at most the last ~150 ms of changes,
// and the data no longer lives in a local file.
//
// First start after upgrading: if MongoDB has no app data yet and server/data.json exists, the
// JSON is imported automatically and the file is renamed to data.json.migrated-<timestamp>
// (kept as a backup, never deleted).
import mongoose from 'mongoose';
import fs from 'node:fs';

const itemSchema = new mongoose.Schema({
  kind: { type: String, required: true },       // recipient | campaign | attachment | singleton
  itemId: { type: String, required: true },
  data: mongoose.Schema.Types.Mixed,
  blob: Buffer,                                  // campaign attachment bytes (kept out of the campaign doc)
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false, minimize: false });
itemSchema.index({ kind: 1, itemId: 1 }, { unique: true });
export const StoreItem = mongoose.models.StoreItem || mongoose.model('StoreItem', itemSchema, 'app_store');

const toBuffer = b => {
  if (!b) return null;
  if (Buffer.isBuffer(b)) return b;
  const raw = b.buffer ?? b; // BSON Binary from lean() reads
  return Buffer.from(raw.subarray ? raw.subarray(0, b.position ?? raw.length) : raw);
};

export function createStore({ model = StoreItem, logger = console } = {}) {
  // What MongoDB currently holds, as serialized strings, so only real changes are written.
  const synced = { recipient: new Map(), campaign: new Map(), singleton: new Map() };
  const syncedAttachments = new Map(); // campaignId -> attachment object last written
  let state = null;                    // { recipients, campaigns, activity, templates, settings } (live references)
  let timer = null, running = null, rerun = false, lastError = null;

  const campaignDoc = c => { const { attachment, ...rest } = c; return JSON.stringify(attachment ? { ...rest, attachment: { filename: attachment.filename, mimetype: attachment.mimetype, size: attachment.size } } : rest); };

  async function readAll() {
    const docs = await model.find({}).lean();
    const out = { recipient: new Map(), campaign: new Map(), attachment: new Map(), singleton: new Map() };
    for (const d of docs) out[d.kind]?.set(d.itemId, d);
    return out;
  }

  const ordered = (map, orderIds) => {
    const items = [], seen = new Set();
    for (const id of orderIds || []) { const d = map.get(id); if (d) { items.push(d.data); seen.add(id); } }
    for (const [id, d] of map) if (!seen.has(id)) items.push(d.data); // safety: never drop an item missing from the order list
    return items;
  };

  /** Returns { recipients, campaigns, activity, templates, settings, source } where source is 'mongodb' | 'legacy-json' | 'defaults'. */
  async function load({ legacyFile, defaults }) {
    const all = await readAll();
    let result;
    if (all.recipient.size || all.campaign.size || all.singleton.size) {
      const sg = k => all.singleton.get(k)?.data;
      const campaigns = ordered(all.campaign, sg('order:campaigns')).map(c => {
        const att = all.attachment.get(c.id);
        if (att?.blob) c.attachment = { filename: att.data?.filename, mimetype: att.data?.mimetype, size: att.data?.size, buffer: toBuffer(att.blob) };
        return c;
      });
      result = { recipients: ordered(all.recipient, sg('order:recipients')), campaigns, activity: sg('activity') || [], templates: sg('templates') || [], settings: sg('settings') || {}, source: 'mongodb' };
      // Everything just read is, by definition, already stored: seed the diff cache.
      for (const [id, d] of all.recipient) synced.recipient.set(id, JSON.stringify(d.data));
      for (const [id, d] of all.campaign) synced.campaign.set(id, JSON.stringify(d.data));
      for (const c of campaigns) if (c.attachment) syncedAttachments.set(c.id, c.attachment);
      for (const [k, d] of all.singleton) synced.singleton.set(k, JSON.stringify(d.data));
    } else if (legacyFile && fs.existsSync(legacyFile)) {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); }
      catch (e) { const bak = `${legacyFile}.corrupt-${Date.now()}`; fs.copyFileSync(legacyFile, bak); logger.error(`data.json could not be read (${e.message}). A copy was kept at ${bak}. Starting with sample data.`); raw = null; }
      if (raw) {
        const campaigns = (raw.campaigns || []).map(c => {
          if (c.attachment?.bufferBase64) c.attachment = { filename: c.attachment.filename, mimetype: c.attachment.mimetype, size: c.attachment.size, buffer: Buffer.from(c.attachment.bufferBase64, 'base64') };
          return c;
        });
        result = { recipients: raw.recipients || [], campaigns, activity: raw.activity || [], templates: raw.templates || [], settings: raw.settings || {}, source: 'legacy-json' };
      }
    }
    if (!result) { const d = defaults(); result = { ...d, source: 'defaults' }; }
    return result;
  }

  /** Register the live arrays so sync() can diff them. */
  function bind(s) { state = s; }

  async function syncOnce() {
    if (!state) return;
    const ops = [], commits = [];
    const now = new Date();
    const diff = (kind, items, serialize, extra = x => ({})) => {
      const cache = synced[kind], seen = new Set();
      for (const item of items) {
        const json = serialize(item); seen.add(item.id);
        if (cache.get(item.id) !== json) {
          ops.push({ replaceOne: { filter: { kind, itemId: item.id }, replacement: { kind, itemId: item.id, data: JSON.parse(json), updatedAt: now }, upsert: true } });
          commits.push(() => cache.set(item.id, json));
        }
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) {
        ops.push({ deleteOne: { filter: { kind, itemId: id } } });
        commits.push(() => cache.delete(id));
      }
    };
    const single = (key, value) => {
      const json = JSON.stringify(value);
      if (synced.singleton.get(key) !== json) {
        ops.push({ replaceOne: { filter: { kind: 'singleton', itemId: key }, replacement: { kind: 'singleton', itemId: key, data: JSON.parse(json), updatedAt: now }, upsert: true } });
        commits.push(() => synced.singleton.set(key, json));
      }
    };
    diff('recipient', state.recipients, r => JSON.stringify(r));
    diff('campaign', state.campaigns, campaignDoc);
    single('order:recipients', state.recipients.map(r => r.id));
    single('order:campaigns', state.campaigns.map(c => c.id));
    single('activity', state.activity);
    single('templates', state.templates);
    single('settings', state.settings());

    const campaignIds = new Set(state.campaigns.map(c => c.id));
    for (const c of state.campaigns) {
      if (c.attachment?.buffer && syncedAttachments.get(c.id) !== c.attachment) {
        const a = c.attachment;
        ops.push({ replaceOne: { filter: { kind: 'attachment', itemId: c.id }, replacement: { kind: 'attachment', itemId: c.id, data: { filename: a.filename, mimetype: a.mimetype, size: a.size }, blob: a.buffer, updatedAt: now }, upsert: true } });
        commits.push(() => syncedAttachments.set(c.id, a));
      }
    }
    for (const id of [...syncedAttachments.keys()]) {
      const c = state.campaigns.find(x => x.id === id);
      if (!c?.attachment || !campaignIds.has(id)) {
        ops.push({ deleteOne: { filter: { kind: 'attachment', itemId: id } } });
        commits.push(() => syncedAttachments.delete(id));
      }
    }
    if (!ops.length) return;
    // Large lists are written in chunks so a 100k-recipient import never builds one giant request.
    for (let i = 0; i < ops.length; i += 1000) await model.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    commits.forEach(fn => fn());
  }

  /** Write pending changes now. Concurrent calls are coalesced; resolves when MongoDB has acknowledged. */
  async function flush() {
    clearTimeout(timer); timer = null;
    if (running) { rerun = true; return running; }
    running = (async () => {
      try {
        do { rerun = false; await syncOnce(); lastError = null; } while (rerun);
      } catch (e) {
        lastError = e; logger.error('Failed to save data to MongoDB:', e.message);
        timer = setTimeout(() => flush().catch(() => {}), 5000); // retry; nothing is marked as saved until MongoDB confirms
        timer.unref?.();
      } finally { running = null; }
    })();
    return running;
  }

  /** Debounced save (called after every change). */
  function schedule() { clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 150); timer.unref?.(); }

  const status = () => ({ ok: !lastError, pending: Boolean(timer || running), lastError: lastError?.message || null });
  return { load, bind, flush, schedule, status };
}
