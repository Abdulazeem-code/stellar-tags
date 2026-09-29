"use strict";

const {
  MemorySlidingWindowStore,
  SLIDING_WINDOW_LUA,
  createSlidingWindowRateLimiter,
} = require("../src/middleware/slidingWindowRateLimit");

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
  it("smooths requests across fixed-window boundaries", async () => {
    const store = new MemorySlidingWindowStore();

    expect((await store.hit("client", 100, 1_000, 2)).allowed).toBe(true);
    expect((await store.hit("client", 900, 1_000, 2)).allowed).toBe(true);

    // A fixed window resets at t=1000 and would allow this burst. The sliding
    // window still sees both requests made during the preceding second.
    expect((await store.hit("client", 1_001, 1_000, 2)).allowed).toBe(false);
    expect((await store.hit("client", 1_101, 1_000, 2)).allowed).toBe(true);
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
});
