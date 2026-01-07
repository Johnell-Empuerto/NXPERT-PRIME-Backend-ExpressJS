const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");
require("dotenv").config();

router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "PUT", "DELETE"],
    credentials: true,
  })
);

// GET single user by ID
router.get("/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT user_id, emp_id, name, age, role, department, shift, status, 
       email, contact_number, date_hired, profile_image, created_at
       FROM Usermaster WHERE user_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Database error" });
  }
});

// UPDATE user
router.put("/:id", auth, isAdmin, async (req, res) => {
  const { id } = req.params;
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

  // Basic validation
  if (!emp_id || !name || !email) {
    return res.status(400).json({
      error: "Employee ID, Name, and Email are required",
    });
  }

  // Password validation if provided
  if (password && password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters long",
    });
  }

  try {
    // Check if user exists
    const userCheck = await pool.query(
      "SELECT * FROM Usermaster WHERE user_id = $1",
      [id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if email or emp_id already exists for other users
    const existingUser = await pool.query(
      `SELECT * FROM Usermaster WHERE (emp_id = $1 OR email = $2) AND user_id != $3`,
      [emp_id, email, id]
    );

    if (existingUser.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Employee ID or Email already exists" });
    }

    let updateQuery;
    let queryParams;

    if (password && password.trim() !== "") {
      // Hash new password if provided and not empty
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      updateQuery = `
        UPDATE Usermaster 
        SET emp_id = $1, name = $2, age = $3, role = $4, department = $5, 
            shift = $6, status = $7, email = $8, contact_number = $9, 
            date_hired = $10, password = $11
        WHERE user_id = $12 
        RETURNING *`;

      queryParams = [
        emp_id,
        name,
        age || null,
        role || null,
        department || null,
        shift || null,
        status || "Active",
        email,
        contact_number || null,
        date_hired || null,
        hashedPassword,
        id,
      ];
    } else {
      // Update without changing password
      updateQuery = `
        UPDATE Usermaster 
        SET emp_id = $1, name = $2, age = $3, role = $4, department = $5, 
            shift = $6, status = $7, email = $8, contact_number = $9, 
            date_hired = $10
        WHERE user_id = $11 
        RETURNING *`;

      queryParams = [
        emp_id,
        name,
        age || null,
        role || null,
        department || null,
        shift || null,
        status || "Active",
        email,
        contact_number || null,
        date_hired || null,
        id,
      ];
    }

    const result = await pool.query(updateQuery, queryParams);

    // Remove password from response
    const updatedUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = updatedUser;

    res.json({
      message: "User updated successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    console.error("Error updating user:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// DELETE user (soft delete - mark as inactive)
router.delete("/:id", auth, isAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Check if user exists
    const userCheck = await pool.query(
      "SELECT * FROM Usermaster WHERE user_id = $1",
      [id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Soft delete - mark as inactive
    const result = await pool.query(
      "UPDATE Usermaster SET status = 'Inactive' WHERE user_id = $1 RETURNING *",
      [id]
    );

    // Remove password from response
    const deletedUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = deletedUser;

    res.json({
      message: "User deleted successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

module.exports = router;
