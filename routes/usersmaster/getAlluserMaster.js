const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
require("dotenv").config();

// Apply route-specific logger middleware
router.use(routeLogger("/users/get-all"));

// Enable CORS for React dev server
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET"],
    credentials: true,
  })
);

// GET all users
router.get("/", async (req, res) => {
  const logger = req.logger;

  try {
    logger.route("=== GET ALL USERS STARTED ===");
    const startTime = Date.now();

    // Log request info
    logger.debug("Request details:", {
      ip: req.ip,
      userAgent: req.get("user-agent"),
      queryParams: req.query,
    });

    logger.debug("Executing database query for non-admin users");
    const result = await pool.query(
      `SELECT user_id, emp_id, name, age, role, department, shift, status, date_hired, contact_number, email, created_at, profile_image, is_admin
       FROM Usermaster
       WHERE role <> 'Admin'
       ORDER BY name ASC`
    );

    const queryTime = Date.now() - startTime;
    const userCount = result.rows.length;

    logger.debug(`Database query completed in ${queryTime}ms`, {
      rows_returned: userCount,
      query_time_ms: queryTime,
    });

    if (userCount > 0) {
      // Count users by status for analytics
      const activeCount = result.rows.filter(
        (u) => u.status === "Active"
      ).length;
      const inactiveCount = result.rows.filter(
        (u) => u.status === "Inactive"
      ).length;

      logger.debug("User statistics:", {
        total_users: userCount,
        active_users: activeCount,
        inactive_users: inactiveCount,
      });

      // Log a few users for debugging (without sensitive info)
      if (userCount <= 5) {
        logger.debug(
          "All users:",
          result.rows.map((u) => ({
            id: u.user_id,
            name: u.name,
            emp_id: u.emp_id,
            role: u.role,
          }))
        );
      } else {
        logger.debug(
          `First 3 of ${userCount} users:`,
          result.rows.slice(0, 3).map((u) => ({
            id: u.user_id,
            name: u.name,
            emp_id: u.emp_id,
            role: u.role,
          }))
        );
      }
    } else {
      logger.warn("No users found in database matching criteria");
    }

    const totalTime = Date.now() - startTime;
    logger.route("=== GET ALL USERS COMPLETED ===");
    logger.info(`Successfully served ${userCount} users in ${totalTime}ms`);

    res.json(result.rows);
  } catch (err) {
    const errorTime = Date.now();
    logger.error("Error fetching all users", {
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
      execution_time_ms: errorTime,
    });

    // Check for specific database errors
    if (err.message.includes("connection") || err.message.includes("timeout")) {
      logger.error("Database connection issue detected");
    }

    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
