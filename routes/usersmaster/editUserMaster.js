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
router.use(routeLogger("/users/manage"));

// Enable CORS
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "PUT", "DELETE"],
    credentials: true,
  })
);

// GET single user by ID
router.get("/:id", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { id } = req.params;

  try {
    logger.route(`=== GET USER BY ID STARTED: ${id} ===`);
    logger.debug(`Fetching user details for user_id: ${id}`);

    const result = await pool.query(
      `SELECT user_id, emp_id, name, age, role, department, shift, status, 
       email, contact_number, date_hired, profile_image, created_at, is_admin
       FROM Usermaster WHERE user_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      logger.warn(`User not found with ID: ${id}`);
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    logger.debug(`User found: ${user.name} (${user.emp_id})`);
    logger.route(`=== GET USER BY ID COMPLETED: ${id} ===`);

    res.json(user);
  } catch (err) {
    logger.error("Error fetching user by ID", {
      error: err.message,
      user_id: id,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// UPDATE user
router.put("/:id", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
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
    is_admin,
  } = req.body;

  try {
    logger.route(`=== UPDATE USER STARTED: ${id} ===`);
    logger.debug("Update request data:", {
      emp_id: emp_id,
      name: name,
      email: email,
      password_provided: !!password,
      is_admin: is_admin,
    });

    // Basic validation
    if (!emp_id || !name || !email) {
      logger.warn("User update failed: Missing required fields", {
        emp_id: !!emp_id,
        name: !!name,
        email: !!email,
      });
      return res.status(400).json({
        error: "Employee ID, Name, and Email are required",
      });
    }

    // Password validation if provided
    if (password && password.length < 6) {
      logger.warn("User update failed: Password too short", {
        password_length: password.length,
      });
      return res.status(400).json({
        error: "Password must be at least 6 characters long",
      });
    }

    // Check if user exists
    logger.debug("Checking if user exists in database");
    const userCheck = await pool.query(
      "SELECT * FROM Usermaster WHERE user_id = $1",
      [id]
    );

    if (userCheck.rows.length === 0) {
      logger.warn(`User not found with ID: ${id}`);
      return res.status(404).json({ error: "User not found" });
    }

    const existingUser = userCheck.rows[0];
    logger.debug(
      `Existing user found: ${existingUser.name} (${existingUser.emp_id})`
    );

    // Check if email or emp_id already exists for other users
    logger.debug("Checking for duplicate emp_id or email");
    const duplicateCheck = await pool.query(
      `SELECT * FROM Usermaster WHERE (emp_id = $1 OR email = $2) AND user_id != $3`,
      [emp_id, email, id]
    );

    if (duplicateCheck.rows.length > 0) {
      const duplicate = duplicateCheck.rows[0];
      logger.warn("User update failed: Employee ID or Email already exists", {
        duplicate_emp_id: duplicate.emp_id,
        duplicate_email: duplicate.email,
        duplicate_user_id: duplicate.user_id,
      });
      return res
        .status(400)
        .json({ error: "Employee ID or Email already exists" });
    }

    let updateQuery;
    let queryParams;

    if (password && password.trim() !== "") {
      logger.debug("Password provided - hashing new password");
      // Hash new password if provided and not empty
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      updateQuery = `
        UPDATE Usermaster 
        SET emp_id = $1, name = $2, age = $3, role = $4, department = $5, 
            shift = $6, status = $7, email = $8, contact_number = $9, 
            date_hired = $10, password = $11, is_admin = $12
        WHERE user_id = $13
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
        is_admin || false,
        id,
      ];
    } else {
      logger.debug("No password provided - updating without password change");
      // Update without changing password
      updateQuery = `
        UPDATE Usermaster 
        SET emp_id = $1, name = $2, age = $3, role = $4, department = $5, 
            shift = $6, status = $7, email = $8, contact_number = $9, 
            date_hired = $10, is_admin = $11
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
        is_admin || false,
        id,
      ];
    }

    logger.debug("Executing update query");
    const result = await pool.query(updateQuery, queryParams);

    // Remove password from response
    const updatedUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = updatedUser;

    logger.debug("User updated successfully", {
      user_id: updatedUser.user_id,
      emp_id: updatedUser.emp_id,
      status: updatedUser.status,
      is_admin: updatedUser.is_admin,
    });

    logger.route(`=== UPDATE USER COMPLETED: ${id} ===`);
    logger.info(
      `User updated: ${updatedUser.name} (ID: ${id}) by admin: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.json({
      message: "User updated successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    logger.error("Error updating user", {
      error: err.message,
      user_id: id,
      emp_id: emp_id,
      name: name,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// DELETE user (soft delete - mark as inactive)
router.delete("/:id", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { id } = req.params;

  try {
    logger.route(`=== DELETE USER STARTED: ${id} ===`);
    logger.debug(`Attempting to delete (deactivate) user ID: ${id}`);

    // Check if user exists
    const userCheck = await pool.query(
      "SELECT * FROM Usermaster WHERE user_id = $1",
      [id]
    );

    if (userCheck.rows.length === 0) {
      logger.warn(`User not found for deletion: ${id}`);
      return res.status(404).json({ error: "User not found" });
    }

    const userToDelete = userCheck.rows[0];
    logger.debug(
      `User found for deletion: ${userToDelete.name} (${userToDelete.emp_id})`
    );

    // Soft delete - mark as inactive
    const result = await pool.query(
      "UPDATE Usermaster SET status = 'Inactive' WHERE user_id = $1 RETURNING *",
      [id]
    );

    // Remove password from response
    const deletedUser = result.rows[0];
    const { password: _, ...userWithoutPassword } = deletedUser;

    logger.debug("User marked as inactive", {
      user_id: deletedUser.user_id,
      old_status: userToDelete.status,
      new_status: deletedUser.status,
    });

    logger.route(`=== DELETE USER COMPLETED: ${id} ===`);
    logger.info(
      `User deactivated: ${deletedUser.name} (ID: ${id}) by admin: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.json({
      message: "User deleted successfully",
      user: userWithoutPassword,
    });
  } catch (err) {
    logger.error("Error deleting user", {
      error: err.message,
      user_id: id,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error: " + err.message });
  }
});

module.exports = router;
