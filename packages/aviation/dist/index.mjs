// src/index.ts
import cron from "node-cron";
import { db } from "@wwv-seeders/shared";
import { setLiveSnapshot } from "@wwv-seeders/shared";
import * as Sentry from "@sentry/node";
import { fetch } from "undici";
var PROXY_WORKER_URL = "https://wwv-proxy.titmitna.workers.dev/?url=";
var OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
var OPENSKY_DATA_URL = "https://opensky-network.org/api/states/all";
var ROTATION_THRESHOLD = 50;
var POLLING_INTERVAL_MS = 5e3;
var FLUSH_INTERVAL_MS = 5e3;
var messageBuffer = [];
var pool = {
  _openskyPool: [],
  _openskyActiveIdx: 0,
  _lastResetTime: Date.now()
};
function initCredentialPool() {
  if (pool._openskyPool.length > 0) return;
  const creds = [];
  const raw = process.env.OPENSKY_CREDENTIALS;
  if (raw) {
    for (const pair of raw.split(",")) {
      const trimmed = pair.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const clientId = trimmed.slice(0, colonIdx);
      const clientSecret = trimmed.slice(colonIdx + 1);
      if (clientId && clientSecret) {
        creds.push({ clientId, clientSecret, accessToken: null, tokenExpiry: 0, creditsRemaining: null, exhausted: false });
      }
    }
  }
  if (creds.length === 0) {
    const clientId = process.env.OPENSKY_CLIENTID;
    const clientSecret = process.env.OPENSKY_CLIENTSECRET;
    if (clientId && clientSecret) {
      creds.push({ clientId, clientSecret, accessToken: null, tokenExpiry: 0, creditsRemaining: null, exhausted: false });
    }
  }
  pool._openskyPool = creds;
  pool._openskyActiveIdx = 0;
  pool._lastResetTime = Date.now();
  console.log(`[Aviation] Initialised pool with ${creds.length} credential(s).`);
}
function resetCredentialPool() {
  console.log("[Aviation] Resetting credential pool exhaustion flags...");
  for (const cred of pool._openskyPool) {
    cred.exhausted = false;
    cred.creditsRemaining = null;
  }
  pool._openskyActiveIdx = 0;
  pool._lastResetTime = Date.now();
}
function getActiveCredential() {
  const creds = pool._openskyPool;
  if (!creds || creds.length === 0) return null;
  const current = creds[pool._openskyActiveIdx];
  if (current && !current.exhausted) return current;
  for (let i = 0; i < creds.length; i++) {
    if (!creds[i].exhausted) {
      pool._openskyActiveIdx = i;
      console.log(`[Aviation] Rotated \u2192 now using credential ${i + 1}/${creds.length}: ${creds[i].clientId}`);
      return creds[i];
    }
  }
  const twelveHoursMs = 12 * 60 * 60 * 1e3;
  if (Date.now() - pool._lastResetTime > twelveHoursMs) {
    console.warn(`[Aviation] Emergency Reset: All credentials exhausted, but last reset was > 12h ago. Attempting pool reset.`);
    resetCredentialPool();
    return getActiveCredential();
  }
  console.warn(`[Aviation] All ${creds.length} credentials exhausted.`);
  return null;
}
function rotateCredential() {
  const current = pool._openskyPool[pool._openskyActiveIdx];
  if (current) current.exhausted = true;
  getActiveCredential();
}
async function fetchTokenForCredential(cred) {
  const now = Date.now();
  if (cred.accessToken && now < cred.tokenExpiry) return cred.accessToken;
  try {
    const url = `${PROXY_WORKER_URL}${encodeURIComponent(OPENSKY_TOKEN_URL)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cred.clientId,
        client_secret: cred.clientSecret
      }).toString()
    });
    if (!res.ok) return null;
    const data = await res.json();
    cred.accessToken = data.access_token;
    cred.tokenExpiry = now + data.expires_in * 1e3 - 3e4;
    return cred.accessToken;
  } catch (err) {
    console.warn(`[Aviation] Token fetch error: ${err.message}`);
    return null;
  }
}
var insertHistory = db.prepare(`
    INSERT OR IGNORE INTO aviation_history (icao24, ts, lat, lon, alt, hdg, spd, fetched_at)
    VALUES (@icao24, @ts, @lat, @lon, @alt, @hdg, @spd, @fetched_at)
`);
async function pollOpenSky() {
  var _a;
  const pollStart = Date.now();
  console.log(`[Aviation] Poll starting...`);
  const cred = getActiveCredential();
  let token = null;
  if (cred) {
    token = await fetchTokenForCredential(cred);
  }
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12e3);
    const url = `${PROXY_WORKER_URL}${encodeURIComponent(OPENSKY_DATA_URL)}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.status === 429) {
      console.warn("[Aviation] 429 Rate Limit hit.");
      if (cred) rotateCredential();
      return 429;
    }
    const creditsRemainingStr = (_a = response.headers) == null ? void 0 : _a.get("x-ratelimit-remaining");
    if (creditsRemainingStr && cred) {
      const rem = parseInt(creditsRemainingStr, 10);
      cred.creditsRemaining = rem;
      if (rem <= ROTATION_THRESHOLD) rotateCredential();
    }
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    if (data.states && Array.isArray(data.states)) {
      const activeStates = data.states.filter((s) => s[6] !== null && s[5] !== null);
      messageBuffer.push(activeStates);
      console.log(`[Aviation] Poll OK: ${activeStates.length} aircraft in ${Date.now() - pollStart}ms`);
    }
    return 200;
  } catch (err) {
    console.error(`[Aviation] Polling Error (${Date.now() - pollStart}ms): ${err.message}`);
    const isTimeout = err.code === "UND_ERR_CONNECT_TIMEOUT" || err.name === "AbortError" || err.message.includes("fetch failed") || err.message.includes("timeout");
    if (!isTimeout) {
      if (err.cause) {
        console.error(`[Aviation] Cause:`, err.cause);
      }
      Sentry.captureException(err, { extra: { cause: err.cause, durationMs: Date.now() - pollStart } });
    } else {
      console.warn(`[Aviation] Network/Timeout error suppressed from Sentry to preserve quota.`);
    }
    return 500;
  }
}
var nextPollTimeout = null;
var currentPollDelay = POLLING_INTERVAL_MS;
async function pollLoop() {
  try {
    const status = await pollOpenSky();
    if (status === 429) {
      currentPollDelay = Math.min(currentPollDelay * 2, 10 * 60 * 1e3);
      console.warn(`[Aviation] Backing off. Next poll in ${currentPollDelay / 1e3}s`);
    } else if (status === 200) {
      currentPollDelay = POLLING_INTERVAL_MS;
    } else {
      currentPollDelay = Math.min(currentPollDelay * 1.5, 60 * 1e3);
    }
  } catch (e) {
    currentPollDelay = Math.min(currentPollDelay * 1.5, 60 * 1e3);
  } finally {
    nextPollTimeout = setTimeout(pollLoop, currentPollDelay);
  }
}
async function flushBuffer() {
  if (messageBuffer.length === 0) return;
  const latestStates = messageBuffer.pop();
  messageBuffer = [];
  if (!latestStates || latestStates.length === 0) return;
  const fetchedAt = Math.floor(Date.now() / 1e3);
  const fleetObj = /* @__PURE__ */ Object.create(null);
  let insertedCount = 0;
  const insertMany = db.transaction((states) => {
    var _a;
    for (const s of states) {
      const icao24 = s[0];
      const callsign = ((_a = s[1]) == null ? void 0 : _a.trim()) || null;
      const ts = s[3] || s[4] || fetchedAt;
      const lon = s[5];
      const lat = s[6];
      const alt = s[7];
      const on_ground = s[8];
      const spd = s[9];
      const hdg = s[10];
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
      const stateObj = {
        icao24,
        callsign,
        origin_country: s[2],
        time_position: s[3],
        last_contact: s[4],
        lon,
        lat,
        alt,
        on_ground,
        spd: on_ground ? 0 : spd,
        hdg: on_ground ? 0 : hdg,
        vertical_rate: s[11],
        sensors: s[12],
        geo_altitude: s[13],
        squawk: s[14],
        spi: s[15],
        position_source: s[16],
        last_updated: fetchedAt
      };
      fleetObj[icao24] = stateObj;
    }
  });
  try {
    insertMany(latestStates);
    await setLiveSnapshot("aviation", fleetObj, 10 * 60);
  } catch (err) {
    console.error("[Aviation] Buffer flush failed:", err);
    Sentry.captureException(err, { extra: { context: "flushBuffer" } });
  }
}
function startAviationPoller() {
  initCredentialPool();
  console.log("[Aviation] Starting background polling...");
  cron.schedule("0 0 * * *", () => {
    resetCredentialPool();
  });
  setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  pollLoop();
}
var index_default = {
  name: "aviation",
  init: startAviationPoller
};
export {
  index_default as default,
  startAviationPoller
};
