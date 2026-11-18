const { maintenanceMiddleware } = require("../../src/middleware/maintenance");
const { errorBody } = require("../../src/errors");

describe("maintenanceMiddleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = { path: "/api/test", correlationId: "test-correlation-id" };
    res = {
      set: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    delete process.env.MAINTENANCE_MODE;
  });

  afterAll(() => {
    delete process.env.MAINTENANCE_MODE;
  });

  test("should call next() if MAINTENANCE_MODE is not set", () => {
    maintenanceMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("should call next() if MAINTENANCE_MODE is 'false'", () => {
    process.env.MAINTENANCE_MODE = "false";
    maintenanceMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("should return 503 and set Retry-After if MAINTENANCE_MODE is 'true'", () => {
    process.env.MAINTENANCE_MODE = "true";
    maintenanceMiddleware(req, res, next);
    
    expect(res.set).toHaveBeenCalledWith("Retry-After", "3600");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      errorBody("SERVICE_UNAVAILABLE", "The system is currently undergoing maintenance. Please try again later.", {
        correlationId: "test-correlation-id",
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test("should allow /health endpoint to pass through even in maintenance mode", () => {
    process.env.MAINTENANCE_MODE = "true";
    req.path = "/health";
    maintenanceMiddleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("should allow /api/health endpoint to pass through even in maintenance mode", () => {
    process.env.MAINTENANCE_MODE = "true";
    req.path = "/api/health";
    maintenanceMiddleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
