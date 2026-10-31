// Usage (inside server/):  npm run owner-token
// Creates/repairs OWNER_SETUP_TOKEN in server/.env and prints it so you can paste it in the browser.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(dir, '../.env');
const token = crypto.randomBytes(32).toString('hex'); // 64 chars, letters+digits only
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
// remove every existing OWNER_SETUP_TOKEN line (duplicates cause confusion), then add one clean line
env = env.split(/\r?\n/).filter(l => !/^\s*OWNER_SETUP_TOKEN\s*=/.test(l)).join('\n').replace(/\s*$/, '\n');
env += `OWNER_SETUP_TOKEN=${token}\n`;
fs.writeFileSync(envPath, env);
console.log('\nNew OWNER_SETUP_TOKEN written to', envPath);
console.log('\nPaste this into the browser form (after restarting the backend):\n\n' + token + '\n');
