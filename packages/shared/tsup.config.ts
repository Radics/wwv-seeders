import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  shims: true,
  noExternal: [/@wwv-seeders\/.*/],
  external: [/^(?!@wwv-seeders)[a-z@].*/],
});
