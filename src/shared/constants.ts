import type { ModelFitLevel, ModelFitSummary, TaskPreset } from './types.js';

export const APP_VERSION = '1.3.0';
export const DEV_SESSION_TOKEN = 'chat2diff-dev-token';
export const DEFAULT_PORT = 4310;
export const MAX_FILE_SIZE_BYTES = 250 * 1024; // 250 KB per source file

export const MODEL_LIMITS = {
  chatgpt: 128_000,
  claude: 200_000,
  gemini: 1_000_000,
} as const;

export const TASK_PRESETS: Record<
  TaskPreset,
  { label: string; shortDesc: string; instruction: string }
> = {
  bug_fix: {
    label: 'Fix a Bug',
    shortDesc: 'Find the root cause and repair broken behavior',
    instruction:
      'Identify the root cause of the bug described below and make the cleanest minimal fix without breaking existing functionality.',
  },
  add_feature: {
    label: 'Add a Feature',
    shortDesc: 'Build new functionality matching the existing code style',
    instruction:
      'Implement the requested feature cleanly, matching the project architecture, naming conventions, and coding patterns.',
  },
  improve_code: {
    label: 'Improve Code',
    shortDesc: 'Refactor for clarity, speed, or better structure',
    instruction:
      'Refactor and improve the selected code for readability, maintainability, and performance while preserving external behavior.',
  },
  review_code: {
    label: 'Review Only',
    shortDesc: 'Spot bugs, security risks, or edge cases',
    instruction:
      'Review the selected code carefully for bugs, edge cases, and security issues. Only include code edits if fixing clear defects.',
  },
};

export const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.chat2diff',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  '.cache',
  'target',
  'vendor',
]);

export const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.pyc', '.pyo',
  '.class', '.jar', '.war', '.apk', '.aab',
  '.onnx', '.tflite', '.pt', '.pth', '.safetensors', '.gguf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mkv', '.mov', '.avi',
  '.db', '.sqlite', '.sqlite3', '.parquet', '.faiss',
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks',
]);

export const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'cargo.lock',
  'uv.lock',
  'composer.lock',
  'bun.lockb',
  '.ds_store',
  'thumbs.db',
]);

export const SENSITIVE_PATCH_PATTERNS = [
  '.env',
  '.github/workflows',
  'package.json',
  'dockerfile',
  'mcp_config.json',
  'id_rsa',
  'credentials',
  'secrets',
];

export function evaluateModelFit(estimatedTokens: number): ModelFitSummary {
  const classify = (limit: number): ModelFitLevel => {
    if (estimatedTokens <= limit * 0.6) return 'great';
    if (estimatedTokens <= limit * 0.88) return 'tight';
    return 'too_large';
  };
  return {
    chatgpt: classify(MODEL_LIMITS.chatgpt),
    claude: classify(MODEL_LIMITS.claude),
    gemini: classify(MODEL_LIMITS.gemini),
  };
}
