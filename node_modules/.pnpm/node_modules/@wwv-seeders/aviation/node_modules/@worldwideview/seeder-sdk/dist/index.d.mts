import { Database } from 'better-sqlite3';
import { Redis } from 'ioredis';

declare const db: Database;
/**
 * Initialize all required tables for the different seeders.
 * This runs synchronously on boot.
 */
declare function initDB(): void;
declare function pruneHistoryTables(): void;

declare const redis: Redis;
/**
 * Convenience method to write a JSON payload to Redis with an expiration.
 * Writes are throttled to save Redis requests, but websockets are always broadcasted.
 */
declare function setLiveSnapshot(source: string, payload: any, ttlSeconds: number): Promise<void>;
/**
 * Convenience method to read a JSON payload from Redis.
 */
declare function getLiveSnapshot(source: string): Promise<any>;

declare function withRetry<T>(fn: () => Promise<T>, maxRetries?: number, delayMs?: number): Promise<T>;
declare function fetchWithTimeout(url: string, options?: any, timeoutMs?: number): Promise<Response>;
/**
 * Calculates distance in Kilometers between two coordinates.
 * Useful for filtering events by proximity (e.g., nuclear test sites).
 */
declare function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number;
declare const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
declare function sleep(ms: number): Promise<unknown>;

interface GeoLocation {
    lat: number;
    lon: number;
    country: string;
    city: string;
}
/**
 * Geolocate an IPv4 address using the local geoip-lite database.
 * Returns null for private/unresolvable IPs.
 */
declare function geolocateIp(ip: string): GeoLocation | null;

export { CHROME_UA, type GeoLocation, db, fetchWithTimeout, geolocateIp, getLiveSnapshot, haversineKm, initDB, pruneHistoryTables, redis, setLiveSnapshot, sleep, withRetry };
