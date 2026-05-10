// src/index.ts
import { setLiveSnapshot } from "@wwv-seeders/shared";
import * as Sentry from "@sentry/node";
var WTIA_API_URL = "https://api.wheretheiss.at/v1/satellites/25544";
var POLLING_INTERVAL_MS = 5e3;
async function fetchISSData() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12e3);
    const response = await fetch(WTIA_API_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "WorldWideView/1.0" }
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error(`[ISS] WTIA returned status ${response.status}`);
      return;
    }
    const data = await response.json();
    const stateObj = {
      id: data.id,
      name: "International Space Station",
      latitude: data.latitude,
      longitude: data.longitude,
      altitude: data.altitude,
      // in km
      velocity: data.velocity,
      // km/h
      visibility: data.visibility,
      footprint: data.footprint,
      timestamp: data.timestamp,
      daynum: data.daynum,
      solar_lat: data.solar_lat,
      solar_lon: data.solar_lon,
      units: "kilometers"
    };
    const redisPayload = {
      "25544": stateObj
    };
    await setLiveSnapshot("iss", redisPayload, 60);
  } catch (e) {
    if (e.name === "AbortError") {
      console.error("[ISS] Polling timeout");
      Sentry.captureException(e, { extra: { context: "iss_timeout" } });
    } else {
      console.error("[ISS] Polling error:", e.message);
      Sentry.captureException(e, { extra: { context: "iss_polling", cause: e.cause } });
    }
  }
}
var pollInterval = null;
function startISSSeeder() {
  console.log("[ISS] Starting ISS telemetry seeder...");
  fetchISSData();
  pollInterval = setInterval(fetchISSData, POLLING_INTERVAL_MS);
}
var index_default = {
  name: "iss",
  init: startISSSeeder
};
export {
  index_default as default,
  startISSSeeder
};
