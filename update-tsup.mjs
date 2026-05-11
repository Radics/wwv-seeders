import fs from 'fs';
import path from 'path';

const p = 'c:/dev/wwv-seeders/packages';
const dirs = fs.readdirSync(p);

for (const d of dirs) {
  const tsupPath = path.join(p, d, 'tsup.config.ts');
  const tsupContent = `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  shims: true,
  noExternal: [/@wwv-seeders\\/.*/],
  external: [/^(?!@wwv-seeders)[a-z@].*/],
});
`;
  fs.writeFileSync(tsupPath, tsupContent);
}
