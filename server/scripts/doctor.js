// Usage (inside server/):  npm run doctor
// Checks server/.env, MongoDB and Redis and tells you exactly what to fix. Never prints secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { validateEnv, scanEnvFile } from '../src/envCheck.js';
import { cleanToken, tokenFingerprint } from '../src/ownerToken.js';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
const ok = m => console.log('  \u2713', m), bad = m => { console.log('  \u2717', m); failed++; }, warn = m => console.log('  !', m);
let failed = 0;

console.log(`\nChecking ${envPath}`);
if (!fs.existsSync(envPath)) { bad('server/.env does not exist. Copy server/.env.example to server/.env, then run: npm run owner-token'); process.exit(1); }
ok('server/.env found');
const text = fs.readFileSync(envPath, 'utf8');
for (const i of scanEnvFile(text)) warn(i);
dotenv.config({ path: envPath, override: true });
if (process.env.OWNER_SETUP_TOKEN !== dotenv.parse(text).OWNER_SETUP_TOKEN) warn('OWNER_SETUP_TOKEN differs from the file (another definition in the file wins). Run: npm run owner-token');

const { errors, warnings } = validateEnv(process.env);
errors.forEach(bad); warnings.forEach(warn);
if (!errors.length) ok('Required settings look valid');
const t = cleanToken(process.env.OWNER_SETUP_TOKEN);
console.log(`  i Owner setup token: length=${t.length} fingerprint=${t ? tokenFingerprint(t) : '-'} (compare with the number shown in the browser error)`);

console.log('\nMongoDB');
try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }); ok('Connected'); const n = await mongoose.connection.db.collection('users').countDocuments(); console.log(`  i Admin accounts: ${n}${n ? ' (Owner setup screen is disabled once an admin exists)' : ''}`); }
catch (e) { bad(`Cannot connect: ${e.message}. If you use Atlas, check Network Access (your IP) and the username/password in MONGODB_URI.`); }
finally { await mongoose.disconnect().catch(() => {}); }

console.log('\nRedis (email queue)');
const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 3000 });
redis.on('error', () => {});
try { await redis.connect(); await redis.ping(); ok('Connected'); } catch (e) { bad(`Cannot connect: ${e.message}. Start Redis (docker compose up -d redis) or fix REDIS_URL. Sending campaigns needs it.`); }
finally { redis.disconnect(); }

console.log(failed ? `\n${failed} problem(s) found.\n` : '\nAll good.\n');
process.exit(failed ? 1 : 0);
