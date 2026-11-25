import path from 'node:path';

export interface SecretScanResult {
  redactedContent: string;
  count: number;
  labels: string[];
}

const SECRET_RULES: Array<{ label: string; regex: RegExp }> = [
  { label: 'Private Key Block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'OpenAI / Provider API Key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35,}\b/g },
  { label: 'GitHub Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { label: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Groq API Key', regex: /\bgsk_[A-Za-z0-9]{24,}\b/g },
  { label: 'Slack Token', regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
];

export function isSecretFilename(relPosixPath: string): boolean {
  const base = path.posix.basename(relPosixPath).toLowerCase();
  if (base.startsWith('.env')) {
    const allowedExamples = ['.env.example', '.env.sample', '.env.template'];
    return !allowedExamples.includes(base);
  }
  return (
    base.includes('serviceaccount') ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  );
}

export function scanAndRedactSecrets(content: string, redact: boolean): SecretScanResult {
  let result = content;
  let count = 0;
  const labels = new Set<string>();

  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    result = result.replace(rule.regex, (match) => {
      count += 1;
      labels.add(rule.label);
      return redact ? `{{REDACTED_SECRET_${count}}}` : match;
    });
  }

  return {
    redactedContent: result,
    count,
    labels: Array.from(labels),
  };
}
