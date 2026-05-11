// src/index.ts
import fs from "fs";
import path from "path";
import { z } from "zod";
import { db } from "@wwv-seeders/shared";
import { setLiveSnapshot } from "@wwv-seeders/shared";
import { fetchWithTimeout, withRetry } from "@wwv-seeders/shared";
import * as Sentry from "@sentry/node";
var itemSchema = z.object({
  event_id: z.string().max(255),
  type: z.string().max(255).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  timestamp: z.string().max(100),
  confidence: z.string().max(100).nullable().optional(),
  event_summary: z.string().max(1e4).nullable().optional(),
  source_url: z.string().max(2e3).nullable().optional(),
  preview_image: z.string().url().max(2e3).nullable().optional(),
  _osint_meta: z.any().optional()
});
var insertEvent = db.prepare(`
  INSERT INTO iranwar_events (event_id, payload, timestamp, fetched_at) 
  VALUES (@event_id, @payload, @timestamp, @fetched_at)
  ON CONFLICT(event_id) DO UPDATE SET 
    payload=excluded.payload, 
    timestamp=excluded.timestamp
`);
var getTopEvents = db.prepare("SELECT payload FROM iranwar_events ORDER BY timestamp DESC LIMIT 500");
var hasHydratedSeed = false;
async function seedIranWarLive() {
  if (!hasHydratedSeed) {
    console.log("[IranWarLive] Initializing: Hydrating/Upserting active fallback seed...");
    const seedPath = path.join(__dirname, "..", "..", "seedData", "iranwar_seed.json");
    if (fs.existsSync(seedPath)) {
      const fallbackData = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      const fetchedAt = Date.now();
      let insertedCount = 0;
      let variables = 0;
      const upsertMany = db.transaction((events) => {
        for (const item of events) {
          try {
            const validatedItem = itemSchema.parse(item);
            const result = insertEvent.run({
              event_id: validatedItem.event_id,
              payload: JSON.stringify(validatedItem),
              timestamp: validatedItem.timestamp,
              fetched_at: fetchedAt
            });
            if (result.changes > 0) insertedCount++;
          } catch (err) {
          }
        }
      });
      upsertMany(fallbackData);
      console.log(`[IranWarLive] Boot hydration complete. Merged ${insertedCount} seed events.`);
    }
    hasHydratedSeed = true;
  }
  console.log("[IranWarLive] Polling iranwarlive.com/feed.json...");
  let data = null;
  try {
    const response = await withRetry(() => fetchWithTimeout("https://iranwarlive.com/feed.json", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    console.warn(`[IranWarLive] Failed to fetch live feed (anti-bot block?): ${err.message}. Using local database cache.`);
    Sentry.captureException(err, { extra: { context: "iranwarlive_fetch" } });
  }
  if (data && data.items && Array.isArray(data.items) && data.items.length > 0) {
    const fetchedAt = Date.now();
    let insertedCount = 0;
    const placeholders = data.items.map(() => "?").join(",");
    const existingIdsStmt = db.prepare(`SELECT event_id FROM iranwar_events WHERE event_id IN (${placeholders})`);
    const existingIdsRow = existingIdsStmt.all(...data.items.map((i) => i.event_id));
    const existingIds = new Set(existingIdsRow.map((row) => row.event_id));
    const newItems = data.items.filter((item) => !existingIds.has(item.event_id));
    if (newItems.length > 0) {
      console.log(`[IranWarLive] Found ${newItems.length} new events. Hydrating og:images...`);
      for (const item of newItems) {
        if (item.source_url) {
          try {
            const htmlRes = await fetchWithTimeout(item.source_url, { headers: { "User-Agent": "WorldWideView-OSINT/1.0" } }, 5e3);
            const html = await htmlRes.text();
            const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
            if (ogMatch && ogMatch[1]) {
              item.preview_image = ogMatch[1];
            }
          } catch (err) {
            console.warn(`[IranWarLive] Failed to hydrate image for ${item.event_id}: ${err.message}`);
          }
        }
      }
      const insertMany = db.transaction((events) => {
        for (const item of events) {
          try {
            const validatedItem = itemSchema.parse(item);
            const result = insertEvent.run({
              event_id: validatedItem.event_id,
              payload: JSON.stringify(validatedItem),
              timestamp: validatedItem.timestamp,
              fetched_at: fetchedAt
            });
            if (result.changes > 0) insertedCount++;
          } catch (err) {
            console.warn(`[IranWarLive] Skipped item due to validation error: ${err.message}`);
          }
        }
      });
      insertMany(newItems);
      if (insertedCount > 0) {
        console.log(`[IranWarLive] Added ${insertedCount} new hydrated events to history.`);
      }
    } else {
      console.log("[IranWarLive] No new events found.");
    }
  }
  const rows = getTopEvents.all();
  const history = rows.map((row) => JSON.parse(row.payload));
  await setLiveSnapshot("iranwarlive", {
    source: "iranwarlive",
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    items: history
  }, 3600);
}
var index_default = {
  name: "iranwarlive",
  cron: "*/1 * * * *",
  // Every minute
  fn: seedIranWarLive
};
export {
  index_default as default,
  seedIranWarLive
};
