// ../shared/db.ts
import Database from "better-sqlite3";
import path from "path";
var dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "engine.db");
var db = new Database(dbPath, {
  // Use verbose logging if needed for debugging
  // verbose: console.log
});
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
function initDB() {
  console.log(`[DB] Initializing SQLite database at ${dbPath}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS iranwar_events (
      event_id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      timestamp TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS earthquakes (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wildfires (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS maritime_history (
      mmsi TEXT NOT NULL,
      ts INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      hdg REAL,
      spd REAL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (mmsi, ts)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_maritime_history_mmsi_ts ON maritime_history(mmsi, ts);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_maritime_history_ts ON maritime_history(ts);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS aviation_history (
      icao24 TEXT NOT NULL,
      ts INTEGER NOT NULL,
      lat REAL,
      lon REAL,
      alt REAL,
      hdg REAL,
      spd REAL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (icao24, ts)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_aviation_history_icao24_ts ON aviation_history(icao24, ts);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_aviation_history_ts ON aviation_history(ts);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS military_aviation_history (
      hex TEXT NOT NULL,
      ts INTEGER NOT NULL,
      lat REAL,
      lon REAL,
      alt REAL,
      hdg REAL,
      spd REAL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (hex, ts)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_military_aviation_history_hex_ts ON military_aviation_history(hex, ts);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_military_aviation_history_ts ON military_aviation_history(ts);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS gps_jamming (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_events (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS civil_unrest (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cyber_attacks (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cyber_attacks_source_ts ON cyber_attacks(source_ts);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sanctions (
      id TEXT PRIMARY KEY,
      payload JSON NOT NULL,
      source_ts INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    )
  `);
  console.log("[DB] All tables initialized successfully.");
}
initDB();

// ../shared/redis.ts
import Redis from "ioredis";
import dotenv from "dotenv";
import path2 from "path";
import zlib from "zlib";
dotenv.config({ path: path2.resolve(process.cwd(), ".env.local") });
var redisUrl = process.env.REDIS_URL || "redis://redis:6379";
if (redisUrl.includes("upstash.io") && redisUrl.startsWith("redis://")) {
  console.warn("\n\x1B[33m[CONFIG WARNING]\x1B[0m \u{1F6A8} Upstash environment detected via redis:// without TLS.");
  console.warn("Automatically upgrading process connection pipeline to rediss:// protocol...\n");
  redisUrl = redisUrl.replace(/^redis:\/\//, "rediss://");
}
console.log(`[Redis] Connecting to ${redisUrl.replace(/:[^:@]+@/, ":***@")} ...`);
var redis = new Redis(redisUrl, {
  // Common reconnect strategy
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2e3);
    return delay;
  },
  maxRetriesPerRequest: 3
});
redis.on("error", (err) => {
  console.error("[Redis] Connection Error against URL:", redisUrl.replace(/:[^:@]+@/, ":***@"));
  console.error("[Redis] Error Object:", err);
});
redis.on("ready", () => {
  console.log("[Redis] Connected and ready.");
});
var lastSnapshotTimes = /* @__PURE__ */ new Map();
var SNAPSHOT_THROTTLE_MS = 5 * 60 * 1e3;
async function setLiveSnapshot(source, payload, ttlSeconds) {
  try {
    if (typeof globalThis.broadcastPluginData === "function") {
      globalThis.broadcastPluginData(source, payload);
    }
    const now = Date.now();
    const lastTime = lastSnapshotTimes.get(source) || 0;
    if (now - lastTime < SNAPSHOT_THROTTLE_MS) {
      return;
    }
    lastSnapshotTimes.set(source, now);
    const key = `data:${source}:live`;
    const jsonStr = JSON.stringify(payload);
    const compressed = zlib.gzipSync(Buffer.from(jsonStr, "utf-8"));
    await redis.set(key, compressed, "EX", ttlSeconds);
    await redis.set(`meta:${source}:last_run`, Date.now().toString(), "EX", ttlSeconds * 2);
    console.log(`[Redis] Snapshot saved to Redis for ${source} (${(compressed.length / 1024).toFixed(2)} KB)`);
  } catch (error) {
    console.error(`[Redis] Failed to snapshot ${source}:`, error);
  }
}

// ../shared/geoip.ts
import geoip from "geoip-lite";

// src/index.ts
import crypto from "crypto";
import * as Sentry from "@sentry/node";
var CONFLICT_HOTSPOTS = [
  { lat: 48.3794, lon: 31.1656, radius: 5 },
  // Ukraine
  { lat: 31.0461, lon: 34.8516, radius: 2 },
  // Israel/Gaza
  { lat: 15.5007, lon: 32.5599, radius: 6 },
  // Sudan
  { lat: 15.3694, lon: 44.191, radius: 3 },
  // Yemen
  { lat: 14.4974, lon: 14.4524, radius: 8 },
  // Sahel region
  { lat: 16.8661, lon: 96.1951, radius: 5 },
  // Myanmar
  { lat: 5.1521, lon: 46.1996, radius: 4 }
  // Somalia
];
var EVENT_TYPES = [
  "Battles",
  "Explosions/Remote violence",
  "Violence against civilians",
  "Protests",
  "Riots",
  "Strategic developments"
];
var WEAPON_TYPES = [
  "Artillery",
  "Airstrike",
  "Drone strike",
  "Armed clashes",
  "IED",
  "Small arms"
];
function generateMockConflictEvents() {
  const events = [];
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  for (const hotspot of CONFLICT_HOTSPOTS) {
    const numEvents = Math.floor(Math.random() * 10) + 5;
    for (let i = 0; i < numEvents; i++) {
      const u = Math.random();
      const v = Math.random();
      const w = hotspot.radius / 111;
      const t = 2 * Math.PI * v;
      const x = w * Math.cos(t);
      const y = w * Math.sin(t);
      const lat = hotspot.lat + y;
      const lon = hotspot.lon + x;
      const type = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
      const subType = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
      const fatalities = Math.floor(Math.random() * 10) === 0 ? Math.floor(Math.random() * 50) : Math.floor(Math.random() * 5);
      events.push({
        id: crypto.randomUUID(),
        latitude: lat,
        longitude: lon,
        type,
        subType,
        actor1: "Unidentified Armed Group",
        actor2: "State Forces",
        fatalities,
        date: today,
        source: "Mock ACLED Data",
        notes: "Reported " + type.toLowerCase() + " involving " + subType.toLowerCase() + "."
      });
    }
  }
  return events;
}
var insertStmt = db.prepare("INSERT OR REPLACE INTO conflict_events (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)");
async function fetchConflictEvents() {
  console.log("[Seeder: ConflictEvents] Mocking ACLED data generation...");
  const events = generateMockConflictEvents();
  const now = Date.now();
  let inserted = 0;
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertStmt.run(row);
      inserted++;
    }
  });
  const dbRows = events.map((e) => ({
    id: e.id,
    payload: JSON.stringify(e),
    source_ts: now,
    fetched_at: now
  }));
  insertMany(dbRows);
  console.log("[Seeder: ConflictEvents] Inserted " + inserted + " events into DB.");
  try {
    const geoEntities = events.map((e) => ({
      id: "conflict-" + e.id,
      latitude: e.latitude,
      longitude: e.longitude,
      properties: {
        type: e.type,
        subType: e.subType,
        fatalities: e.fatalities,
        actor1: e.actor1,
        actor2: e.actor2,
        date: e.date,
        notes: e.notes
      }
    }));
    await setLiveSnapshot("conflict_events", geoEntities, 3600 * 24);
  } catch (err) {
    console.warn("[Seeder: ConflictEvents] Redis cache failed:", err);
    Sentry.captureException(err, { extra: { context: "conflictEvents_redis" } });
  }
}
var index_default = {
  name: "conflictEvents",
  cron: "0 0 * * *",
  // Run daily at midnight
  fn: fetchConflictEvents
};
export {
  index_default as default,
  fetchConflictEvents
};
