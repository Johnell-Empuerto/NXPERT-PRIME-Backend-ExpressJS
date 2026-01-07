const jwt = require("jsonwebtoken");

const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt"); // Use bcrypt instead of bcryptjs
require("dotenv").config();

// Enable CORS only for this route
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

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
    // Find user by emp_id only
    const result = await pool.query(
      "SELECT * FROM Usermaster WHERE emp_id = $1",
      [empId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }

    const user = result.rows[0];

    // Check if user is active
    if (user.status !== "Active") {
      return res.json({
        success: false,
        message: "Account is not active. Please contact administrator.",
      });
    }

    // Compare the plain text password with the hashed password in database
    // Using bcrypt.compare() for bcrypt
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (isValidPassword) {
      // Remove sensitive data before sending to client
      const { password: _, ...userWithoutPassword } = user;

      // ✅ CREATE JWT HERE
      const token = jwt.sign(
        {
          user_id: user.user_id,
          emp_id: user.emp_id,
          role: user.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "1d" }
      );

      res.json({
        success: true,
        user: userWithoutPassword,
        message: "Login successful",
        token, // 👈 SEND TOKEN
        user: userWithoutPassword, // 👈 USER DATA
      });
    } else {
      res.json({
        success: false,
        message: "Invalid Employee ID or password",
      });
    }
  } catch (err) {
    console.error("Login error:", err.message);

    // Special handling for bcrypt errors
    if (err.message.includes("data") && err.message.includes("salt")) {
      console.log("Bcrypt comparison error - possible password format issue");

      // Check if password is in wrong format (not bcrypt hashed)
      const user = result?.rows[0];
      if (user && !user.password.startsWith("$2")) {
        console.log(
          "Password is not bcrypt hashed. Need to hash existing passwords."
        );
        return res.json({
          success: false,
          message: "System error. Please contact administrator.",
        });
      }
    }

    res.status(500).json({
      success: false,
      message: "Database error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

module.exports = router;
