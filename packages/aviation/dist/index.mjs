// src/index.ts
import { db } from "@worldwideview/seeder-sdk";
import { setLiveSnapshot } from "@worldwideview/seeder-sdk";
import * as Sentry from "@sentry/node";
var ADSB_URL = "https://api.adsb.lol/v2/lat/30.27/lon/-97.74/dist/250";
var POLLING_INTERVAL_MS = 15e3;
var insertHistory = db.prepare(`
    INSERT OR IGNORE INTO aviation_history (icao24, ts, lat, lon, alt, hdg, spd, fetched_at)
    VALUES (@icao24, @ts, @lat, @lon, @alt, @hdg, @spd, @fetched_at)
`);
async function pollAviation() {
  const pollStart = Date.now();
  console.log(`[Aviation] Poll starting...`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12e3);
    const response = await fetch(ADSB_URL, {
      headers: { "User-Agent": "WorldWideView-DataEngine" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      if (response.status === 429) {
        console.warn("[Aviation] 429 Rate Limit hit.");
      }
      throw new Error(`Status ${response.status}`);
    }
    const data = await response.json();
    if (!data.ac || !Array.isArray(data.ac)) {
      console.warn("[Aviation] No aircraft array in response.");
      return;
    }
    const fetchedAt = Math.floor(Date.now() / 1e3);
    const fleetObj = /* @__PURE__ */ Object.create(null);
    let insertedCount = 0;
    const insertMany = db.transaction((aircraft) => {
      for (const ac of aircraft) {
        if (ac.lat == null || ac.lon == null) continue;
        const icao24 = ac.hex;
        const ts = Math.floor(
          (ac.seen_pos != null ? Date.now() - ac.seen_pos * 1e3 : Date.now()) / 1e3
        );
        const lon = ac.lon;
        const lat = ac.lat;
        const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : 0;
        const on_ground = ac.alt_baro === "ground";
        const spd = ac.gs ?? 0;
        const hdg = ac.track ?? 0;
        if (!on_ground) {
          const result = insertHistory.run({
            icao24,
            ts,
            lat,
            lon,
            alt,
            hdg,
            spd,
            fetched_at: fetchedAt
          });
          if (result.changes > 0) insertedCount++;
        }
        fleetObj[icao24] = {
          icao24,
          callsign: (ac.flight ?? "").trim() || null,
          origin_country: null,
          // not provided by adsb.lol
          time_position: ts,
          last_contact: ts,
          lon,
          lat,
          alt,
          // feet (baro)
          on_ground,
          spd: on_ground ? 0 : spd,
          hdg: on_ground ? 0 : hdg,
          vertical_rate: ac.baro_rate ?? null,
          sensors: null,
          geo_altitude: ac.alt_geom ?? null,
          squawk: ac.squawk ?? null,
          spi: ac.spi ?? false,
          position_source: 0,
          last_updated: fetchedAt,
          // bonus fields from adsb.lol
          registration: ac.r ?? null,
          aircraft_type: ac.t ?? null,
          category: ac.category ?? null
        };
      }
    });
    insertMany(data.ac);
    await setLiveSnapshot("aviation", fleetObj, 10 * 60);
    console.log(`[Aviation] Poll OK: ${data.ac.length} aircraft (${insertedCount} new history) in ${Date.now() - pollStart}ms`);
  } catch (err) {
    const isTimeout = err.name === "AbortError" || err.code === "UND_ERR_CONNECT_TIMEOUT";
    if (isTimeout) {
      console.warn(`[Aviation] Timeout after ${Date.now() - pollStart}ms`);
    } else {
      console.error(`[Aviation] Poll error: ${err.message}`);
      if (err.cause) console.error(`[Aviation] Cause:`, err.cause);
      Sentry.captureException(err, { extra: { cause: err.cause, context: "aviation-poll" } });
    }
  }
}
function startAviationPoller() {
  console.log("[Aviation] Starting Austin-area ADS-B polling via adsb.lol (250nm radius)...");
  setInterval(pollAviation, POLLING_INTERVAL_MS);
  pollAviation();
}
var index_default = {
  name: "aviation",
  init: startAviationPoller
};
export {
  index_default as default,
  startAviationPoller
};
