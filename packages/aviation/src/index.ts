import cron from 'node-cron';
import { db } from '@worldwideview/seeder-sdk';
import { redis, setLiveSnapshot } from '@worldwideview/seeder-sdk';

import * as Sentry from '@sentry/node';
import { fetch } from 'undici';

const PROXY_WORKER_URL = "https://wwv-proxy.titmitna.workers.dev/?url=";

const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const OPENSKY_DATA_URL = "https://opensky-network.org/api/states/all";
const ROTATION_THRESHOLD = 50;
const POLLING_INTERVAL_MS = 5000;
const FLUSH_INTERVAL_MS = 5000;

let messageBuffer: any[] = [];

interface OpenSkyCredential {
    clientId: string;
    clientSecret: string;
    accessToken: string | null;
    tokenExpiry: number;
    creditsRemaining: number | null;
    exhausted: boolean;
}

const pool = {
    _openskyPool: [] as OpenSkyCredential[],
    _openskyActiveIdx: 0,
    _lastResetTime: Date.now()
};

function initCredentialPool(): void {
    if (pool._openskyPool.length > 0) return;

    const creds: OpenSkyCredential[] = [];
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
        // Fallback
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

/**
 * Resets all credentials in the pool to non-exhausted state.
 */
function resetCredentialPool(): void {
    console.log('[Aviation] Resetting credential pool exhaustion flags...');
    for (const cred of pool._openskyPool) {
        cred.exhausted = false;
        cred.creditsRemaining = null;
    }
    pool._openskyActiveIdx = 0;
    pool._lastResetTime = Date.now();
}

function getActiveCredential(): OpenSkyCredential | null {
    const creds = pool._openskyPool;
    if (!creds || creds.length === 0) return null;

    const current = creds[pool._openskyActiveIdx];
    if (current && !current.exhausted) return current;

    for (let i = 0; i < creds.length; i++) {
        if (!creds[i].exhausted) {
            pool._openskyActiveIdx = i;
            console.log(`[Aviation] Rotated → now using credential ${i + 1}/${creds.length}: ${creds[i].clientId}`);
            return creds[i];
        }
    }

    // Emergency Reset: If all are exhausted, but it's been > 12 hours since last reset, 
    // try resetting everything once before giving up.
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    if (Date.now() - pool._lastResetTime > twelveHoursMs) {
        console.warn(`[Aviation] Emergency Reset: All credentials exhausted, but last reset was > 12h ago. Attempting pool reset.`);
        resetCredentialPool();
        return getActiveCredential();
    }

    console.warn(`[Aviation] All ${creds.length} credentials exhausted.`);
    return null;
}

function rotateCredential(): void {
    const current = pool._openskyPool[pool._openskyActiveIdx];
    if (current) current.exhausted = true;
    getActiveCredential();
}

async function fetchTokenForCredential(cred: OpenSkyCredential): Promise<string | null> {
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
                client_secret: cred.clientSecret,
            }).toString(),
        });

        if (!res.ok) return null;

        const data = await res.json() as any;
        cred.accessToken = data.access_token;
        cred.tokenExpiry = now + data.expires_in * 1000 - 30_000;
        return cred.accessToken;
    } catch (err: any) {
        console.warn(`[Aviation] Token fetch error: ${err.message}`);
        return null;
    }
}

// ─── Poller ──────────────────────────────────────────────────

const insertHistory = db.prepare(`
    INSERT OR IGNORE INTO aviation_history (icao24, ts, lat, lon, alt, hdg, spd, fetched_at)
    VALUES (@icao24, @ts, @lat, @lon, @alt, @hdg, @spd, @fetched_at)
`);

async function pollOpenSky(): Promise<number> {
    const pollStart = Date.now();
    console.log(`[Aviation] Poll starting...`);
    const cred = getActiveCredential();
    let token = null;

    if (cred) {
        token = await fetchTokenForCredential(cred);
    }

    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        const url = `${PROXY_WORKER_URL}${encodeURIComponent(OPENSKY_DATA_URL)}`;
        const response = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeoutId);
        
        // Handle limits
        if (response.status === 429) {
            console.warn('[Aviation] 429 Rate Limit hit.');
            if (cred) rotateCredential();
            return 429;
        }

        const creditsRemainingStr = response.headers?.get("x-ratelimit-remaining");
        if (creditsRemainingStr && cred) {
            const rem = parseInt(creditsRemainingStr as string, 10);
            cred.creditsRemaining = rem;
            if (rem <= ROTATION_THRESHOLD) rotateCredential();
        }

        if (!response.ok) throw new Error(`Status ${response.status}`);
        const data = await response.json() as any;

        if (data.states && Array.isArray(data.states)) {
            const activeStates = data.states.filter((s: any) => s[6] !== null && s[5] !== null);
            messageBuffer.push(activeStates);
            console.log(`[Aviation] Poll OK: ${activeStates.length} aircraft in ${Date.now() - pollStart}ms`);
        }
        
        return 200;
    } catch (err: any) {
        console.error(`[Aviation] Polling Error (${Date.now() - pollStart}ms): ${err.message}`);
        
        const isTimeout = err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.name === 'AbortError' || err.message.includes('fetch failed') || err.message.includes('timeout');
        
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

let nextPollTimeout: NodeJS.Timeout | null = null;
let currentPollDelay = POLLING_INTERVAL_MS;

async function pollLoop() {
    try {
        const status = await pollOpenSky();
        
        if (status === 429) {
            // Exponential backoff up to 10 minutes
            currentPollDelay = Math.min(currentPollDelay * 2, 10 * 60 * 1000);
            console.warn(`[Aviation] Backing off. Next poll in ${currentPollDelay / 1000}s`);
        } else if (status === 200) {
            currentPollDelay = POLLING_INTERVAL_MS; // reset on success
        } else {
            // Some other error e.g. 500, connect timeout
            currentPollDelay = Math.min(currentPollDelay * 1.5, 60 * 1000);
        }
    } catch (e) {
        currentPollDelay = Math.min(currentPollDelay * 1.5, 60 * 1000);
    } finally {
        nextPollTimeout = setTimeout(pollLoop, currentPollDelay);
    }
}

async function flushBuffer() {
    if (messageBuffer.length === 0) return;
    
    // We only take the most recent state array from the buffer queue completely resetting it
    const latestStates = messageBuffer.pop();
    messageBuffer = [];

    if (!latestStates || latestStates.length === 0) return;

    const fetchedAt = Math.floor(Date.now() / 1000);
    const fleetObj: Record<string, any> = Object.create(null);
    let insertedCount = 0;

    const insertMany = db.transaction((states) => {
        for (const s of states) {
            const icao24 = s[0] as string;
            const callsign = (s[1] as string)?.trim() || null;
            const ts = s[3] as number || s[4] as number || fetchedAt; // time_position or last_contact
            const lon = s[5] as number;
            const lat = s[6] as number;
            const alt = s[7] as number; // baro_altitude
            const on_ground = s[8] as boolean;
            const spd = s[9] as number;
            const hdg = s[10] as number;

            // 1. Write History to SQLite
            if (!on_ground) {
                const result = insertHistory.run({
                    icao24, ts, lat, lon, alt, hdg, spd, fetched_at: fetchedAt
                });
                if (result.changes > 0) insertedCount++;
            }

            // 2. Prepare Live Cache structure
            // Zero out speed for grounded aircraft so frontend stops extrapolating
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
        // Execute Redis batch via compressed snapshot (10 mins)
        await setLiveSnapshot('aviation', fleetObj, 10 * 60);
    } catch (err) {
        console.error('[Aviation] Buffer flush failed:', err);
        Sentry.captureException(err, { extra: { context: 'flushBuffer' } });
    }
}

export function startAviationPoller() {
    initCredentialPool();
    console.log('[Aviation] Starting background polling...');

    // Daily reset at midnight
    cron.schedule('0 0 * * *', () => {
        resetCredentialPool();
    });

    setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    
    // Initial fetch triggers the loop
    pollLoop();
}

export default {
    name: "aviation",
    init: startAviationPoller
};
