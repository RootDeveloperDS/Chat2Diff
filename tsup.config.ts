import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/server/cli.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});