// src/index.ts
import WebSocket from "ws";
import { db } from "@wwv-seeders/shared";
import { setLiveSnapshot } from "@wwv-seeders/shared";
import * as Sentry from "@sentry/node";
var AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
var API_KEY = process.env.AISSTREAM_API_KEY;
var messageBuffer = [];
var activeFleetCache = /* @__PURE__ */ new Map();
var FLUSH_INTERVAL_MS = 15e3;
var isFlushIntervalRunning = false;
var insertHistory = db.prepare(`
  INSERT OR IGNORE INTO maritime_history (mmsi, ts, lat, lon, hdg, spd, fetched_at)
  VALUES (@mmsi, @ts, @lat, @lon, @hdg, @spd, @fetched_at)
`);
async function flushBuffer() {
  var _a, _b;
  if (messageBuffer.length === 0) return;
  const batch = [...messageBuffer];
  messageBuffer = [];
  const fetchedAt = Date.now();
  let insertedCount = 0;
  const insertMany = db.transaction((msgs) => {
    var _a2, _b2;
    for (const msg of msgs) {
      if (!((_a2 = msg.MetaData) == null ? void 0 : _a2.MMSI) || !((_b2 = msg.Message) == null ? void 0 : _b2.PositionReport)) continue;
      const mmsi = msg.MetaData.MMSI.toString();
      const report = msg.Message.PositionReport;
      const ts = Math.floor(new Date(msg.MetaData.time_utc).getTime() / 1e3);
      const result = insertHistory.run({
        mmsi,
        ts,
        lat: report.Latitude,
        lon: report.Longitude,
        hdg: report.TrueHeading,
        spd: report.Sog,
        fetched_at: fetchedAt
      });
      if (result.changes > 0) insertedCount++;
    }
  });
  try {
    insertMany(batch);
    if (insertedCount > 0) {
    }
    const nowSecs = Math.floor(Date.now() / 1e3);
    for (const [mmsi, ship] of activeFleetCache.entries()) {
      if (nowSecs - ship.last_updated > 6 * 3600) {
        activeFleetCache.delete(mmsi);
      }
    }
    for (const msg of batch) {
      if (!((_a = msg.MetaData) == null ? void 0 : _a.MMSI) || !((_b = msg.Message) == null ? void 0 : _b.PositionReport)) continue;
      const mmsi = msg.MetaData.MMSI.toString();
      const report = msg.Message.PositionReport;
      const ts = Math.floor(new Date(msg.MetaData.time_utc).getTime() / 1e3);
      const shipState = {
        id: `mmsi-${mmsi}`,
        mmsi,
        name: msg.MetaData.ShipName ? msg.MetaData.ShipName.trim() : `Unknown (${mmsi})`,
        lat: report.Latitude,
        lon: report.Longitude,
        hdg: report.TrueHeading,
        spd: report.Sog,
        last_updated: ts
      };
      activeFleetCache.set(mmsi, shipState);
    }
    await setLiveSnapshot("maritime", Object.fromEntries(activeFleetCache), 6 * 3600);
  } catch (err) {
    console.error("[Maritime] Buffer flush failed:", err);
    Sentry.captureException(err, { extra: { context: "flushBuffer", type: "maritime" } });
  }
}
function startMaritimeWebsocket() {
  if (!API_KEY) {
    console.warn("[Maritime] Skipping AIS websocket: AISSTREAM_API_KEY not set.");
    return;
  }
  console.log("[Maritime] Connecting to AisStream.io...");
  const ws = new WebSocket(AISSTREAM_URL);
  let watchdogTimer = null;
  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      console.warn("[Maritime] Watchdog timeout: No messages received in 30s. Forcing reconnect...");
      ws.terminate();
    }, 3e4);
  };
  ws.on("open", () => {
    console.log("[Maritime] WebSocket connected. Subscribing to global feed...");
    const subscriptionMessage = {
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: [],
      FilterMessageTypes: ["PositionReport"]
    };
    ws.send(JSON.stringify(subscriptionMessage));
    resetWatchdog();
  });
  ws.on("message", (data) => {
    var _a;
    resetWatchdog();
    try {
      const msg = JSON.parse(data.toString());
      if (msg.MessageType === "PositionReport" || ((_a = msg.Message) == null ? void 0 : _a.PositionReport)) {
        messageBuffer.push(msg);
      } else if (msg.Error || msg.error) {
        console.error("[Maritime] AISStream Error message received:", msg);
      } else {
        if (msg.MessageType !== "SubscriptionMessage") {
        }
      }
    } catch (e) {
      console.error("[Maritime] AISStream Parse Error. Raw data:", data.toString());
    }
  });
  ws.on("error", (err) => {
    console.error("[Maritime] WebSocket error:", err.message);
    Sentry.captureException(err, { extra: { context: "websocket_error", type: "maritime" } });
  });
  ws.on("close", () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    console.log("[Maritime] WebSocket closed. Reconnecting in 5s...");
    setTimeout(startMaritimeWebsocket, 5e3);
  });
  if (!isFlushIntervalRunning) {
    setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    isFlushIntervalRunning = true;
  }
}
var index_default = {
  name: "maritime",
  init: startMaritimeWebsocket
};
export {
  index_default as default,
  startMaritimeWebsocket
};
