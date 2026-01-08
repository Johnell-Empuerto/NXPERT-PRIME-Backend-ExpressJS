const { createRouteLogger } = require("../utils/logger");

function routeLogger(routeName) {
  const logger = createRouteLogger(routeName);

  return function (req, res, next) {
    // Add logger to request object
    req.logger = logger;

    // Log incoming request (but don't intercept response)
    logger.logRequest(req);

    // Store original send/json methods
    const originalJson = res.json;
    const originalSend = res.send;

    // Only log errors on send/json, don't modify timing
    res.json = function (data) {
      if (res.statusCode >= 400) {
        logger.error(`Error Response: ${req.method} ${req.originalUrl}`, {
          statusCode: res.statusCode,
          data: data,
        });
      }
      originalJson.call(this, data);
    };

    res.send = function (body) {
      if (res.statusCode >= 400) {
        logger.error(`Error Response: ${req.method} ${req.originalUrl}`, {
          statusCode: res.statusCode,
        });
      }
      originalSend.call(this, body);
    };

    next();
  };
}

module.exports = routeLogger;
