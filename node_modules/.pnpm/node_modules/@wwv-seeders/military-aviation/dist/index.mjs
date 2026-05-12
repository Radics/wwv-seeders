// src/index.ts
import { db } from "@worldwideview/seeder-sdk";
import { setLiveSnapshot } from "@worldwideview/seeder-sdk";
import * as Sentry from "@sentry/node";
var ADSB_LOL_URL = "https://api.adsb.lol/v2/mil";
var POLLING_INTERVAL_MS = 6e4;
var insertHistory = db.prepare(`
    INSERT OR IGNORE INTO military_aviation_history (hex, ts, lat, lon, alt, hdg, spd, fetched_at)
    VALUES (@hex, @ts, @lat, @lon, @alt, @hdg, @spd, @fetched_at)
`);
async function pollMilitaryAviation() {
  try {
    const response = await fetch(ADSB_LOL_URL, {
      headers: {
        "User-Agent": "WorldWideView-DataEngine"
      }
    });
    if (!response.ok) {
      if (response.status === 429) {
        console.warn("[MilitaryAviation] 429 Rate Limit hit.");
      }
      throw new Error(`Status ${response.status}`);
    }
    const data = await response.json();
    if (!data.ac || !Array.isArray(data.ac)) return;
    const fetchedAt = Math.floor(Date.now() / 1e3);
    const fleetObj = /* @__PURE__ */ Object.create(null);
    let insertedCount = 0;
    const insertMany = db.transaction((aircraft) => {
      for (const ac of aircraft) {
        if (ac.lat == null || ac.lon == null) continue;
        const hex = ac.hex;
        const ts = Math.floor((ac.seen_pos != null ? Date.now() - ac.seen_pos * 1e3 : Date.now()) / 1e3);
        const lon = ac.lon;
        const lat = ac.lat;
        const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : 0;
        const on_ground = ac.alt_baro === "ground";
        const spd = ac.gs || 0;
        const hdg = ac.track || 0;
        if (!on_ground) {
          const result = insertHistory.run({
            hex,
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
        fleetObj[hex] = {
          hex,
          flight: ac.flight || null,
          r: ac.r || null,
          t: ac.t || null,
          lat,
          lon,
          alt_baro: ac.alt_baro,
          alt_geom: ac.alt_geom,
          gs: ac.gs,
          track: ac.track,
          squawk: ac.squawk,
          dbFlags: ac.dbFlags,
          category: ac.category,
          emergency: ac.emergency,
          seen: ac.seen,
          seen_pos: ac.seen_pos,
          last_updated: fetchedAt
        };
      }
    });
    insertMany(data.ac);
    await setLiveSnapshot("military-aviation", fleetObj, 60 * 60);
  } catch (err) {
    console.error(`[MilitaryAviation] Polling Error: ${err.message}`);
    if (err.cause) {
      console.error(`[MilitaryAviation] Cause:`, err.cause);
    }
    Sentry.captureException(err, { extra: { cause: err.cause, context: "military-aviation" } });
  }
}
function startMilitaryAviationPoller() {
  console.log("[MilitaryAviation] Starting background polling...");
  setInterval(pollMilitaryAviation, POLLING_INTERVAL_MS);
  pollMilitaryAviation();
}
var index_default = {
  name: "military-aviation",
  init: startMilitaryAviationPoller
};
export {
  index_default as default,
  startMilitaryAviationPoller
};
