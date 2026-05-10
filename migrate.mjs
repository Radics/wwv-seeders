import fs from 'fs';
import path from 'path';

const OLD_SRC = 'c:/dev/wwv-data-engine/src';
const SEEDERS_DIR = path.join(OLD_SRC, 'seeders');
const NEW_PACKAGES = 'c:/dev/wwv-seeders/packages';

if (!fs.existsSync(NEW_PACKAGES)) fs.mkdirSync(NEW_PACKAGES, { recursive: true });

// 1. Create shared package
const sharedDir = path.join(NEW_PACKAGES, 'shared');
fs.mkdirSync(sharedDir, { recursive: true });
fs.writeFileSync(path.join(sharedDir, 'package.json'), JSON.stringify({
  name: "@wwv-seeders/shared",
  version: "1.0.0",
  main: "index.ts",
  dependencies: {
    "better-sqlite3": "^11.5.0",
    "ioredis": "^5.4.1",
    "node-fetch": "^2.7.0",
    "@sentry/node": "^8.38.0"
  }
}, null, 2));

const sharedFiles = ['db.ts', 'redis.ts', 'seed-utils.ts', 'geoip.ts'];
for (const f of sharedFiles) {
  if (fs.existsSync(path.join(OLD_SRC, f))) {
    let content = fs.readFileSync(path.join(OLD_SRC, f), 'utf8');
    // We'll just copy it directly
    fs.writeFileSync(path.join(sharedDir, f), content);
  }
}
// Create an index file for shared
fs.writeFileSync(path.join(sharedDir, 'index.ts'), `
export * from './db';
export * from './redis';
export * from './seed-utils';
export * from './geoip';
`);

// 2. Migrate each seeder
const files = fs.readdirSync(SEEDERS_DIR).filter(f => f.endsWith('.ts') && f !== 'index.ts');

for (const file of files) {
  const name = file.replace('.ts', '');
  const seederDir = path.join(NEW_PACKAGES, name);
  fs.mkdirSync(path.join(seederDir, 'src'), { recursive: true });
  
  // Package json
  fs.writeFileSync(path.join(seederDir, 'package.json'), JSON.stringify({
    name: `@wwv-seeders/${name}`,
    version: "1.0.0",
    main: "dist/seeder.mjs",
    scripts: {
      "build": "tsup src/index.ts --format esm --clean --outDir dist"
    },
    dependencies: {
      "@wwv-seeders/shared": "workspace:*",
      "node-cron": "^3.0.3",
      "undici": "^6.19.2",
      "ws": "^8.18.0",
      "zod": "^3.23.8"
    }
  }, null, 2));
  
  // Read code
  let code = fs.readFileSync(path.join(SEEDERS_DIR, file), 'utf8');
  
  // Replace relative imports with shared package
  code = code.replace(/from '\.\.\/db'/g, "from '@wwv-seeders/shared'");
  code = code.replace(/from '\.\.\/redis'/g, "from '@wwv-seeders/shared'");
  code = code.replace(/from '\.\.\/seed-utils'/g, "from '@wwv-seeders/shared'");
  code = code.replace(/from '\.\.\/geoip'/g, "from '@wwv-seeders/shared'");
  code = code.replace(/import \{ registerSeeder \} from '\.\.\/scheduler';\n?/g, "");
  
  // Replace registerSeeder with export default
  code = code.replace(/registerSeeder\(\{([\s\S]*?)\}\);?/, "export default {$1};");
  
  fs.writeFileSync(path.join(seederDir, 'src', 'index.ts'), code);
}

console.log('Migration complete!');
