const jwt = require("jsonwebtoken");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
require("dotenv").config();

// Enable CORS only for this route
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Add debug middleware for this route
router.use((req, res, next) => {
  console.log("\n=== LOGIN ROUTE DEBUG ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Method: ${req.method} ${req.url}`);
  console.log(`Body: ${JSON.stringify(req.body)}`);
  next();
});

router.post("/", async (req, res) => {
  const { empId, password } = req.body;

  // Validate input
  if (!empId || !password) {
    return res.status(400).json({
      success: false,
      message: "Employee ID and password are required",
    });
  }

  try {
    console.log(`\n=== LOGIN ATTEMPT FOR: ${empId} ===`);

    // Find user by emp_id only
    const result = await pool.query(
      "SELECT * FROM Usermaster WHERE emp_id = $1",
      [empId]
    );

    if (result.rows.length === 0) {
      console.log(`User not found with emp_id: ${empId}`);
      return res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }

    const user = result.rows[0];
    console.log(`User found: ${user.name} (ID: ${user.user_id})`);
    console.log(`User is_admin value from DB: ${user.is_admin}`);
    console.log(`User is_admin type from DB: ${typeof user.is_admin}`);
    console.log(`User status: ${user.status}`);

    // Check if user is active
    if (user.status !== "Active") {
      console.log(`User is not active. Status: ${user.status}`);
      return res.json({
        success: false,
        message: "Account is not active. Please contact administrator.",
      });
    }

    // Compare the plain text password with the hashed password in database
    console.log("Comparing password...");
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      console.log("Password comparison failed");
      return res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }

    console.log("Password valid!");

    // Remove sensitive data before sending to client
    const { password: _, ...userWithoutPassword } = user;

    // ✅ CREATE JWT HERE - ADD DEBUG LOGGING
    console.log(`\n=== CREATING JWT TOKEN ===`);
    console.log(`is_admin value for JWT: ${user.is_admin}`);
    console.log(`is_admin type for JWT: ${typeof user.is_admin}`);

    const jwtPayload = {
      user_id: user.user_id,
      emp_id: user.emp_id,
      role: user.role,
      is_admin: user.is_admin, // This is what gets encoded
      name: user.name,
    };

    console.log("JWT Payload to encode:", jwtPayload);

    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // Decode token to verify payload (optional)
    const decoded = jwt.decode(token);
    console.log("JWT Decoded after creation:", decoded);

    // Set cookie if needed (optional)
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    console.log(`\n=== LOGIN SUCCESSFUL ===`);
    console.log(`Token generated for user: ${user.name}`);
    console.log(`is_admin in response: ${user.is_admin}`);

    res.json({
      success: true,
      message: "Login successful",
      token, // 👈 SEND TOKEN
      user: {
        ...userWithoutPassword,
        is_admin: user.is_admin,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    console.error("Error stack:", err.stack);

    // Handle bcrypt errors more cleanly
    if (
      err.message.includes("data") ||
      err.message.includes("salt") ||
      err.message.includes("bcrypt")
    ) {
      console.log("Password comparison error - possible password format issue");

      // You might want to hash plain passwords on the fly here
      // Or just return a generic error
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
