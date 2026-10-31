// Startup configuration checks. Errors stop the server with a clear message; warnings are printed.
const PLACEHOLDER = /replace-with|yourname@|your-|abcd efgh|example\.com/i;

export function validateEnv(env) {
  const errors = [], warnings = [];
  const prod = env.NODE_ENV === 'production';
  const jwt = String(env.JWT_SECRET || '');
  if (!jwt) errors.push('JWT_SECRET is missing. Generate one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  else if (jwt.length < 32) errors.push(`JWT_SECRET is only ${jwt.length} characters; it must be at least 32.`);
  else if (PLACEHOLDER.test(jwt)) (prod ? errors : warnings).push('JWT_SECRET still has the example value. Replace it with a random secret before real use.');

  if (!env.MONGODB_URI) errors.push('MONGODB_URI is missing (MongoDB stores admins, campaigns and recipients).');
  else if (!/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI)) errors.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');

  if (prod && !env.CLIENT_URL) errors.push('CLIENT_URL must be set to the exact frontend origin in production.');

  const setup = String(env.OWNER_SETUP_TOKEN || '').trim();
  if (setup.length < 32) warnings.push('OWNER_SETUP_TOKEN is missing or shorter than 32 characters; first Owner setup will be disabled. Run: npm run owner-token');
  else if (PLACEHOLDER.test(setup)) warnings.push('OWNER_SETUP_TOKEN still has the example value. Run: npm run owner-token');

  const secret = String(env.PROVIDER_WEBHOOK_SECRET || '');
  if (secret && (secret.length < 32 || PLACEHOLDER.test(secret))) warnings.push('PROVIDER_WEBHOOK_SECRET should be a random value of 32+ characters.');

  const provider = String(env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  if (!['smtp', 'brevo', 'ses'].includes(provider)) errors.push(`EMAIL_PROVIDER "${env.EMAIL_PROVIDER}" is not supported (use smtp, brevo or ses).`);
  if (provider === 'smtp' && !env.SMTP_SENDERS_JSON && (!env.SMTP_USER || !env.SMTP_PASS || PLACEHOLDER.test(`${env.SMTP_USER} ${env.SMTP_PASS}`))) warnings.push('SMTP credentials are not set (or are example values): the app will run in demo mode and not send real email.');
  if (env.SMTP_SENDERS_JSON) { try { if (!Array.isArray(JSON.parse(env.SMTP_SENDERS_JSON))) errors.push('SMTP_SENDERS_JSON must be a JSON array.'); } catch { errors.push('SMTP_SENDERS_JSON is not valid JSON.'); } }
  return { errors, warnings };
}

/** Inspect the raw text of a .env file for mistakes that silently break configuration. */
export function scanEnvFile(text) {
  const seen = new Map(), issues = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) { issues.push(`Line ${i + 1} is not KEY=value: "${line.slice(0, 40)}"`); return; }
    const [, key, value] = m;
    if (seen.has(key)) issues.push(`${key} is defined more than once (lines ${seen.get(key)} and ${i + 1}); the later one wins.`);
    else seen.set(key, i + 1);
    if (/^\s|\s$/.test(value) && value.trim() && !/^\s*["']/.test(value)) issues.push(`${key} (line ${i + 1}) has leading/trailing spaces in its value.`);
    if (/^\s*["'].*["']\s*$/.test(value) && key === 'OWNER_SETUP_TOKEN') issues.push(`${key} is wrapped in quotes; remove the quotes.`);
  });
  return issues;
}
