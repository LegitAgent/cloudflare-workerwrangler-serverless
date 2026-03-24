import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

function createEnv(overrides = {}) {
    return {
        ALLOWED_ORIGIN: "https://example.com",
        TIMEZONEDB_KEY: "test-key",
        API_RATE_LIMIT: {
            limit: vi.fn().mockResolvedValue({ success: true })
        },
        ...overrides
    };
}

async function dispatch(request, env = createEnv()) {
    return worker.fetch(request, env);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("timezone worker", () => {
    it("rejects requests from disallowed origins", async () => {
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            headers: { Origin: "https://nope.example.com" }
        });

        const response = await dispatch(request);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    });

    it("accepts a valid preflight request", async () => {
        const env = createEnv();
        const request = new Request("https://worker.test/timezone", {
            method: "OPTIONS",
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
        expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    });

    it("returns 405 for non-GET requests after origin validation", async () => {
        const env = createEnv();
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            method: "POST",
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(405);
        await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
    });

    it("returns 400 when coordinates are missing", async () => {
        const env = createEnv();
        const request = new Request("https://worker.test/timezone?latitude=14.6", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Missing latitude or longitude" });
    });

    it("returns 400 when coordinates are invalid", async () => {
        const env = createEnv();
        const request = new Request("https://worker.test/timezone?latitude=abc&longitude=121", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Invalid coordinates" });
    });

    it("returns 429 when the rate limit binding rejects the request", async () => {
        const env = createEnv({
            API_RATE_LIMIT: {
                limit: vi.fn().mockResolvedValue({ success: false })
            }
        });
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(429);
        await expect(response.json()).resolves.toEqual({
            error: "Rate limit exceeded for /timezone"
        });
    });

    it("returns upstream timezone data for valid coordinates", async () => {
        const env = createEnv();
        const upstreamPayload = {
            status: "OK",
            zoneName: "Asia/Manila",
            gmtOffset: 28800
        };
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify(upstreamPayload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            })
        );
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(upstreamPayload);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toContain("get-time-zone");
        expect(fetchSpy.mock.calls[0][0]).toContain("lat=14.6");
        expect(fetchSpy.mock.calls[0][0]).toContain("lng=121");
    });

    it("returns 404 for routes that do not exist", async () => {
        const env = createEnv();
        const request = new Request("https://worker.test/nope", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "Route not found" });
    });

    it("returns 500 when the API key is missing", async () => {
        const env = createEnv({
            TIMEZONEDB_KEY: undefined
        });
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: "Server misconfiguration" });
    });

    it("returns 504 when the upstream request times out", async () => {
        const env = createEnv();
        vi.spyOn(globalThis, "fetch").mockRejectedValue(
            Object.assign(new Error("timed out"), { name: "AbortError" })
        );
        const request = new Request("https://worker.test/timezone?latitude=14.6&longitude=121", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(504);
        await expect(response.json()).resolves.toEqual({
            error: "External API took too long to respond"
        });
    });

    it("returns the filtered timezone list payload", async () => {
        const env = createEnv();
        const upstreamPayload = {
            status: "OK",
            zones: [
                {
                    countryCode: "PH",
                    countryName: "Philippines",
                    zoneName: "Asia/Manila",
                    gmtOffset: 28800,
                    dst: "0",
                    timestamp: 1710000000
                }
            ]
        };
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify(upstreamPayload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            })
        );
        const request = new Request("https://worker.test/listtimezones", {
            headers: { Origin: env.ALLOWED_ORIGIN }
        });

        const response = await dispatch(request, env);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(upstreamPayload);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toContain("list-time-zone");
        expect(fetchSpy.mock.calls[0][0]).toContain(
            "fields=countryCode,countryName,zoneName,gmtOffset,dst,timestamp"
        );
    });
});
