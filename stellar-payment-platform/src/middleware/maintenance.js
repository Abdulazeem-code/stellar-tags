const { errorBody } = require("../errors");

/**
 * Global middleware that intercepts all non-health-check incoming requests
 * when the MAINTENANCE_MODE environment variable is set to 'true'.
 * It returns an HTTP 503 Service Unavailable with a clean JSON payload notification
 * and sets the Retry-After header.
 */
function maintenanceMiddleware(req, res, next) {
  // Allow health checks to pass through so the container orchestrator doesn't kill the service
  if (req.path === "/health" || req.path === "/v1/health" || req.path === "/api/health" || req.path.includes("/health")) {
    return next();
  }

  if (process.env.MAINTENANCE_MODE === "true") {
    res.set("Retry-After", "3600");
    return res.status(503).json(
      errorBody("SERVICE_UNAVAILABLE", "The system is currently undergoing maintenance. Please try again later.", {
        correlationId: req.correlationId,
      })
    );
  }

  next();
}

module.exports = { maintenanceMiddleware };
