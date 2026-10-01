"use strict";

const {
  MemorySlidingWindowStore,
  SLIDING_WINDOW_LUA,
  createSlidingWindowRateLimiter,
} = require("../src/middleware/slidingWindowRateLimit");
const { createSignatureRateLimiter } = require("../src/middleware/signatureRateLimit");

const createResponse = () => {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: undefined,
    setHeader: jest.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    status: jest.fn(function setStatus(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function sendJson(body) {
      this.body = body;
      return this;
    }),
  };
};

describe("sliding window rate limiter", () => {
  it("requires valid window and limit values", () => {
    expect(() => createSlidingWindowRateLimiter({ windowMs: 0, max: 1 })).toThrow(TypeError);
    expect(() => createSlidingWindowRateLimiter({ windowMs: Infinity, max: 1 })).toThrow(TypeError);
    expect(() => createSlidingWindowRateLimiter({ windowMs: 1_000, max: 0 })).toThrow(TypeError);
    expect(() => createSlidingWindowRateLimiter({ windowMs: 1_000, max: 1.5 })).toThrow(TypeError);
  });

  it("rejects an invalid local capacity", () => {
    expect(() => new MemorySlidingWindowStore({ maxKeys: 0 })).toThrow(TypeError);
    expect(() => new MemorySlidingWindowStore({ maxKeys: 1.5 })).toThrow(TypeError);
  });

  it("smooths requests across fixed-window boundaries", async () => {
    const store = new MemorySlidingWindowStore();

    expect((await store.hit("client", 100, 1_000, 2)).allowed).toBe(true);
    expect((await store.hit("client", 900, 1_000, 2)).allowed).toBe(true);

    // A fixed window resets at t=1000 and would allow this burst. The sliding
    // window still sees both requests made during the preceding second.
    expect((await store.hit("client", 1_001, 1_000, 2)).allowed).toBe(false);
    expect((await store.hit("client", 1_101, 1_000, 2)).allowed).toBe(true);
  });

  it("bounds distinct clients without dropping active limits", async () => {
    const store = new MemorySlidingWindowStore({ maxKeys: 2 });
    await store.hit("first", 100, 1_000, 2);
    await store.hit("second", 200, 1_000, 2);

    const blocked = await store.hit("third", 300, 1_000, 2);
    expect(blocked).toEqual({ allowed: false, count: 2, resetAt: 1_100 });
    expect(store.requests.size).toBe(2);
    expect((await store.hit("first", 400, 1_000, 2)).allowed).toBe(true);
    expect((await store.hit("first", 500, 1_000, 2)).allowed).toBe(false);
    expect(store.requests.size).toBe(2);
  });

  it("removes expired clients and admits new ones", async () => {
    const store = new MemorySlidingWindowStore({ maxKeys: 2 });
    await store.hit("first", 100, 1_000, 1);
    await store.hit("second", 200, 1_000, 1);

    expect((await store.hit("third", 1_101, 1_000, 1)).allowed).toBe(true);
    expect([...store.requests.keys()]).toEqual(["second", "third"]);
    expect((await store.hit("fourth", 1_201, 1_000, 1)).allowed).toBe(true);
    expect([...store.requests.keys()]).toEqual(["third", "fourth"]);
  });

  it("executes the atomic Redis Lua script", async () => {
    const redisClient = {
      eval: jest.fn().mockResolvedValue([1, 1, 50_000]),
    };
    const limiter = createSlidingWindowRateLimiter({
      redisClient,
      windowMs: 60_000,
      max: 10,
      prefix: "test-rl:",
      keyGenerator: () => "account",
      message: { error: { code: "RATE_LIMITED" } },
      now: () => 50_000,
    });
    const response = createResponse();
    const next = jest.fn();

    await limiter({ ip: "127.0.0.1" }, response, next);

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const [script, options] = redisClient.eval.mock.calls[0];
    expect(script).toBe(SLIDING_WINDOW_LUA);
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZADD");
    expect(options.keys).toEqual(["test-rl:account"]);
    expect(options.arguments.slice(0, 3)).toEqual(["50000", "60000", "10"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns standard headers and Retry-After when blocked", async () => {
    let timestamp = 100;
    const limiter = createSlidingWindowRateLimiter({
      windowMs: 1_000,
      max: 1,
      keyGenerator: () => "client",
      message: { error: { code: "RATE_LIMITED" } },
      now: () => timestamp,
    });
    const firstResponse = createResponse();
    await limiter({}, firstResponse, jest.fn());

    timestamp = 200;
    const blockedResponse = createResponse();
    const next = jest.fn();
    await limiter({}, blockedResponse, next);

    expect(blockedResponse.statusCode).toBe(429);
    expect(blockedResponse.body).toEqual({ error: { code: "RATE_LIMITED" } });
    expect(blockedResponse.headers["ratelimit-limit"]).toBe("1");
    expect(blockedResponse.headers["ratelimit-remaining"]).toBe("0");
    expect(blockedResponse.headers["retry-after"]).toBe("1");
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the local fallback for ordinary routes during a Redis error", async () => {
    const redisClient = { eval: jest.fn().mockRejectedValue(new Error("offline")) };
    const limiter = createSlidingWindowRateLimiter({
      redisClient,
      windowMs: 1_000,
      max: 1,
      keyGenerator: () => "client",
      now: () => 100,
      message: { error: { code: "RATE_LIMITED" } },
    });

    const firstNext = jest.fn();
    await limiter({}, createResponse(), firstNext);
    const secondResponse = createResponse();
    await limiter({}, secondResponse, jest.fn());

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondResponse.statusCode).toBe(429);
  });

  it("rejects signature-heavy requests when configured Redis fails", async () => {
    const redisClient = { eval: jest.fn().mockRejectedValue(new Error("offline")) };
    const limiter = createSignatureRateLimiter(redisClient);
    const next = jest.fn();
    const response = createResponse();

    await limiter({ ip: "127.0.0.1" }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ code: "SERVICE_UNAVAILABLE", statusCode: 503 });
    expect(response.statusCode).toBe(200);
  });

  it("skips selected requests without counting them", async () => {
    const redisClient = { eval: jest.fn() };
    const limiter = createSlidingWindowRateLimiter({
      redisClient,
      windowMs: 1_000,
      max: 1,
      skip: () => true,
    });
    const next = jest.fn();
    const response = createResponse();

    await limiter({ ip: "127.0.0.1" }, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redisClient.eval).not.toHaveBeenCalled();
    expect(response.headers).toEqual({});
  });

  it("uses an IP, socket address, or shared unknown key when none is supplied", async () => {
    const limiter = createSlidingWindowRateLimiter({ windowMs: 1_000, max: 1, now: () => 100 });
    const ip = createResponse();
    const socket = createResponse();
    const unknown = createResponse();

    await limiter({ ip: "127.0.0.1" }, ip, jest.fn());
    await limiter({ socket: { remoteAddress: "127.0.0.2" } }, socket, jest.fn());
    await limiter({}, unknown, jest.fn());

    expect(ip.statusCode).toBe(200);
    expect(socket.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    const repeatedUnknown = createResponse();
    await limiter({}, repeatedUnknown, jest.fn());
    expect(repeatedUnknown.statusCode).toBe(429);
  });

  it("uses the local limit for signature requests when Redis is not configured", async () => {
    const limiter = createSignatureRateLimiter(null);
    const next = jest.fn();
    await limiter({ socket: { remoteAddress: "127.0.0.2" } }, createResponse(), next);
    await limiter({}, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
