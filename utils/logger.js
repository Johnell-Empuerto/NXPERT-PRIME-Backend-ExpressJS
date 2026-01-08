const winston = require("winston");
const path = require("path");
const fs = require("fs");

class RouteLogger {
  constructor(routeName) {
    this.routeName = routeName || "global";
    this.routeSlug = this.routeName.toLowerCase().replace(/\//g, "-");
    this.logsDir = path.join(__dirname, "../logs");

    // Create base logs directory
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Create route-specific directory
    this.routeLogsDir = path.join(this.logsDir, "routes", this.routeSlug);
    if (!fs.existsSync(this.routeLogsDir)) {
      fs.mkdirSync(this.routeLogsDir, { recursive: true });
    }

    // Custom levels
    const customLevels = {
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
        route: 4, // Custom level for route-specific logs
      },
      colors: {
        error: "red",
        warn: "yellow",
        info: "green",
        debug: "blue",
        route: "cyan",
      },
    };

    // Create route-specific logger
    this.logger = winston.createLogger({
      levels: customLevels.levels,
      level: "debug",
      format: winston.format.combine(
        winston.format.timestamp({
          format: "YYYY-MM-DD HH:mm:ss.SSS",
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
      ),
      defaultMeta: {
        service: "express-app",
        route: this.routeName,
      },
      transports: [
        // Route-specific error file
        new winston.transports.File({
          filename: path.join(this.routeLogsDir, "errors.txt"),
          level: "error",
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(
              ({ timestamp, level, message, stack, ...meta }) => {
                return `[${timestamp}] [${level.toUpperCase()}] ${message}${
                  stack ? "\nStack: " + stack : ""
                }${
                  Object.keys(meta).length > 2
                    ? "\nMeta: " + JSON.stringify(meta, null, 2)
                    : ""
                }\n---\n`;
              }
            )
          ),
        }),

        // Route-specific debug file
        new winston.transports.File({
          filename: path.join(this.routeLogsDir, "debug.log"),
          level: "debug",
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              return `[${timestamp}] [${level.toUpperCase()}] ${message}${
                Object.keys(meta).length > 2
                  ? " | " + JSON.stringify(meta, null, 2)
                  : ""
              }`;
            })
          ),
        }),

        // Global combined log (optional)
        new winston.transports.File({
          filename: path.join(this.logsDir, "combined.log"),
          level: "info",
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              return `[${timestamp}] [${level.toUpperCase()}] [${
                this.routeName
              }] ${message}`;
            })
          ),
        }),
      ],
    });

    // Add console logging for non-production
    if (process.env.NODE_ENV !== "production") {
      this.logger.add(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
              return `[${timestamp}] [${level}] [${this.routeName}] ${message}`;
            })
          ),
        })
      );
    }
  }

  // Helper methods for different log types
  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  route(message, meta = {}) {
    this.logger.log("route", message, meta);
  }

  // Special method for API requests
  logRequest(req) {
    this.route(`Request: ${req.method} ${req.originalUrl}`, {
      ip: req.ip,
      userAgent: req.get("user-agent"),
      body: req.body,
      query: req.query,
      params: req.params,
    });
  }

  // Special method for API responses
  logResponse(req, res, data = {}) {
    this.route(
      `Response: ${req.method} ${req.originalUrl} - Status: ${res.statusCode}`,
      {
        statusCode: res.statusCode,
        responseTime: Date.now() - req._startTime,
        userId: req.user?.id || "anonymous",
      }
    );
  }
}

// Create a factory function for easy logger creation
function createRouteLogger(routeName) {
  return new RouteLogger(routeName);
}

// Global logger for app-level logs
const globalLogger = new RouteLogger("app");

module.exports = {
  createRouteLogger,
  logger: globalLogger,
};
