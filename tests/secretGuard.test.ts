import { describe, expect, it } from 'vitest';
import { isSecretFilename, scanAndRedactSecrets } from '../src/server/core/secretGuard.js';

describe('secretGuard', () => {
  it('flags .env and key filenames while allowing template files', () => {
    expect(isSecretFilename('.env')).toBe(true);
    expect(isSecretFilename('.env.local')).toBe(true);
    expect(isSecretFilename('certs/server.pem')).toBe(true);
    expect(isSecretFilename('keys/id_rsa')).toBe(true);
    expect(isSecretFilename('.env.example')).toBe(false);
    expect(isSecretFilename('.env.template')).toBe(false);
    expect(isSecretFilename('src/app.ts')).toBe(false);
  });

  it('detects and redacts common API keys when redact is true', () => {
    const fakeKey = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456';
    const fakeGoogle = 'AIza' + 'SyDummyKeyValue1234567890abcdefghijk';
    const sample = `const a = "${fakeKey}";\nconst b = "${fakeGoogle}";\n`;

    const redacted = scanAndRedactSecrets(sample, true);
    expect(redacted.count).toBe(2);
    expect(redacted.redactedContent).not.toContain(fakeKey);
    expect(redacted.redactedContent).not.toContain(fakeGoogle);
    expect(redacted.redactedContent).toContain('{{REDACTED_SECRET_1}}');
    expect(redacted.redactedContent).toContain('{{REDACTED_SECRET_2}}');

    const unmasked = scanAndRedactSecrets(sample, false);
    expect(unmasked.count).toBe(2);
    expect(unmasked.redactedContent).toContain(fakeKey);
  });
});