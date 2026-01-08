const jwt = require("jsonwebtoken");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
require("dotenv").config();
const routeLogger = require("../../middleware/routeLogger"); // Import the middleware

// Apply route-specific logger middleware
router.use(routeLogger("/auth/login"));

// Enable CORS only for this route
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// No need for separate debug middleware - logger middleware handles it

router.post("/", async (req, res) => {
  const { empId, password } = req.body;

  // Use the logger attached to request
  const logger = req.logger;

  // Validate input
  if (!empId || !password) {
    logger.warn(`Login attempt failed: Missing empId or password`);
    return res.status(400).json({
      success: false,
      message: "Employee ID and password are required",
    });
  }

  try {
    logger.route(`=== LOGIN ATTEMPT STARTED FOR: ${empId} ===`);

    // Find user by emp_id only
    const result = await pool.query(
      "SELECT * FROM Usermaster WHERE emp_id = $1",
      [empId]
    );

    if (result.rows.length === 0) {
      logger.warn(`User not found with emp_id: ${empId}`);
      return res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }

    const user = result.rows[0];
    logger.debug(`User found: ${user.name} (ID: ${user.user_id})`);
    logger.debug(`User is_admin value from DB: ${user.is_admin}`);
    logger.debug(`User is_admin type from DB: ${typeof user.is_admin}`);
    logger.debug(`User status: ${user.status}`);

    // Check if user is active
    if (user.status !== "Active") {
      logger.warn(
        `User is not active. Status: ${user.status} for emp_id: ${empId}`
      );
      return res.json({
        success: false,
        message: "Account is not active. Please contact administrator.",
      });
    }

    // Compare passwords
    logger.debug("Starting password comparison...");
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      logger.warn(`Password comparison failed for emp_id: ${empId}`);
      return res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }

    logger.debug("Password validation successful");

    // Remove sensitive data
    const { password: _, ...userWithoutPassword } = user;

    // Create JWT
    logger.debug(`=== CREATING JWT TOKEN ===`);
    logger.debug(`is_admin value for JWT: ${user.is_admin}`);
    logger.debug(`is_admin type for JWT: ${typeof user.is_admin}`);

    const jwtPayload = {
      user_id: user.user_id,
      emp_id: user.emp_id,
      role: user.role,
      is_admin: user.is_admin,
      name: user.name,
    };

    logger.debug("JWT Payload:", jwtPayload);

    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    const decoded = jwt.decode(token);
    logger.debug("JWT Decoded:", decoded);

    // Set cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    logger.route(`=== LOGIN SUCCESSFUL ===`);
    logger.route(`User: ${user.name} logged in successfully`);
    logger.info(
      `Login successful for user: ${user.name} (ID: ${user.user_id})`
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        ...userWithoutPassword,
        is_admin: user.is_admin,
      },
    });
  } catch (err) {
    // Use the request logger
    const logger = req.logger;

    logger.error("Login error occurred", {
      error: err.message,
      stack: err.stack,
      empId: empId,
    });

    if (
      err.message.includes("data") ||
      err.message.includes("salt") ||
      err.message.includes("bcrypt")
    ) {
      logger.error("Password comparison error", {
        type: "bcrypt_error",
        empId: empId,
      });

      return res.status(500).json({
        success: false,
        message: "Authentication system error",
      });
    }

    res.status(500).json({
      success: false,
      message: "Database error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

module.exports = router;
