const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");
require("dotenv").config();

// Enable CORS for React dev server
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["POST"],
    credentials: true,
  })
);

// POST - Add new user to UserMaster
router.post("/", auth, isAdmin, async (req, res) => {
  const {
    emp_id,
    name,
    age,
    role,
    department,
    shift,
    status,
    email,
    contact_number,
    date_hired,
    password,
  } = req.body;

  // Validate required fields
  if (!emp_id || !name || !email || !password) {
    return res.status(400).json({
      error: "Employee ID, Name, Email, and Password are required",
    });
  }

  // Additional validation
  if (password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters long",
    });
  }

  try {
    // Check if user already exists with same emp_id or email
    const existingUser = await pool.query(
      `SELECT * FROM Usermaster WHERE emp_id = $1 OR email = $2`,
      [emp_id, email]
    );

    if (existingUser.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Employee ID or Email already exists" });
    }

    // Hash the password before storing
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert new user with hashed password
    const result = await pool.query(
      `INSERT INTO Usermaster 
       (emp_id, name, age, role, department, shift, status, email, contact_number, date_hired, password) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        emp_id,
        name,
        age || null,
        role || null,
        department || null,
        shift || null,
        status || "Active",
        email,
        contact_number || null,
        date_hired || new Date(),
        hashedPassword, // Use hashed password instead of plain text
      ]
    );

    // Remove password from response for security
    const newUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = newUser;

    res.status(201).json({
      message: "User added successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    console.error("Error adding user:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

module.exports = router;
