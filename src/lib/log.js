import { createRedactor } from './redact.js';

export function createLogger({ write = (line) => process.stdout.write(`${line}\n`), secrets = [] } = {}) {
  const redact = createRedactor(secrets);

  function emit(level, event, fields = {}) {
    const entry = { timestamp: new Date().toISOString(), level, event: redact(event) };
    for (const [key, value] of Object.entries(fields)) {
      if (Object.hasOwn(entry, key) || /token|secret|auth|header|body|stack|url|\b(?:error|request|response)\b/i.test(key)) continue;
      if (typeof value === 'string') entry[key] = redact(value);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) entry[key] = value;
    }
    write(JSON.stringify(entry));
  }

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
