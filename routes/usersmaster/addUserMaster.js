const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");
require("dotenv").config();

// Apply route-specific logger middleware
router.use(routeLogger("/users/create"));

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
    is_admin,
  } = req.body;

  // Use the logger attached to request
  const logger = req.logger;

  // Validate required fields
  if (!emp_id || !name || !email || !password) {
    logger.warn("User creation failed: Missing required fields", {
      emp_id: !!emp_id,
      name: !!name,
      email: !!email,
      password: !!password,
    });
    return res.status(400).json({
      error: "Employee ID, Name, Email, and Password are required",
    });
  }

  // Additional validation
  if (password.length < 6) {
    logger.warn("User creation failed: Password too short", {
      password_length: password.length,
    });
    return res.status(400).json({
      error: "Password must be at least 6 characters long",
    });
  }

  try {
    logger.route(`=== USER CREATION STARTED FOR: ${emp_id} (${name}) ===`);

    // Check if user already exists with same emp_id or email
    logger.debug("Checking for existing user with same emp_id or email");
    const existingUser = await pool.query(
      `SELECT * FROM Usermaster WHERE emp_id = $1 OR email = $2`,
      [emp_id, email]
    );

    if (existingUser.rows.length > 0) {
      const existingEmpId = existingUser.rows.find((u) => u.emp_id === emp_id);
      const existingEmail = existingUser.rows.find((u) => u.email === email);

      logger.warn("User creation failed: Employee ID or Email already exists", {
        emp_id_exists: !!existingEmpId,
        email_exists: !!existingEmail,
      });
      return res
        .status(400)
        .json({ error: "Employee ID or Email already exists" });
    }

    // Hash the password before storing
    logger.debug("Hashing user password");
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert new user with hashed password
    logger.debug("Inserting new user into database");
    const result = await pool.query(
      `INSERT INTO Usermaster 
       (emp_id, name, age, role, department, shift, status, email, contact_number, date_hired, password, is_admin) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
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
        hashedPassword,
        is_admin || false,
      ]
    );

    // Remove password from response for security
    const newUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = newUser;

    logger.debug("User created successfully", {
      user_id: newUser.user_id,
      emp_id: newUser.emp_id,
      role: newUser.role,
      is_admin: newUser.is_admin,
    });

    logger.route(`=== USER CREATION COMPLETED: ${name} (${emp_id}) ===`);
    logger.info(
      `New user created: ${name} (ID: ${newUser.user_id}) by admin: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.status(201).json({
      message: "User added successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    logger.error("Error adding user", {
      error: err.message,
      emp_id: emp_id,
      name: name,
      email: email,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

module.exports = router;
