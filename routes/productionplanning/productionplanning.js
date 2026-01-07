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
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// GET - Fetch all production plans (authenticated users can view)
router.get("/", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM productionPlans ORDER BY start_date DESC`
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching production plans:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// GET - Fetch plans by date range (optional)
router.get("/range", auth, async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    let query = `SELECT * FROM productionPlans`;
    let params = [];

    if (startDate && endDate) {
      query += ` WHERE start_date >= $1 AND end_date <= $2 ORDER BY start_date`;
      params = [startDate, endDate];
    } else {
      query += ` ORDER BY start_date DESC`;
    }

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching plans by range:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// GET - Fetch plan by ID
router.get("/:id", auth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM productionPlans WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Plan not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching plan:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// POST - Adding a Plan
router.post("/", auth, isAdmin, async (req, res) => {
  const {
    product_name,
    process_type,
    description,
    quantity,
    priority,
    shift,
    start_date,
    end_date,
    assigned_operator,
    assigned_machine,
    notes,
  } = req.body;

  // Validate required fields
  if (
    !product_name ||
    !process_type ||
    !quantity ||
    !priority ||
    !shift ||
    !start_date ||
    !end_date ||
    !assigned_operator ||
    !assigned_machine
  ) {
    return res.status(400).json({
      error:
        "Product Name, Process Type, Quantity, Priority, Shift, Start Date, End Date, Assigned Operator, and Assigned Machine are required",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO productionPlans 
       (product_name, process_type, description, quantity, priority, shift, start_date, end_date, assigned_operator, assigned_machine, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        product_name,
        process_type,
        description,
        quantity,
        priority,
        shift,
        start_date,
        end_date,
        assigned_operator,
        assigned_machine,
        notes,
      ]
    );

    res.status(201).json({
      message: "Plane added successfully",
    });
  } catch (err) {
    console.error("Error adding Planned:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// PUT - Update a production plan
router.put("/:id", auth, isAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    product_name,
    process_type,
    description,
    quantity,
    priority,
    shift,
    start_date,
    end_date,
    assigned_operator,
    assigned_machine,
    notes,
    status,
    progress,
  } = req.body;

  // Validate required fields
  if (
    !product_name ||
    !process_type ||
    !quantity ||
    !priority ||
    !shift ||
    !start_date ||
    !end_date ||
    !assigned_operator ||
    !assigned_machine
  ) {
    return res.status(400).json({
      error:
        "Product Name, Process Type, Quantity, Priority, Shift, Start Date, End Date, Assigned Operator, and Assigned Machine are required",
    });
  }

  try {
    // First, check if plan exists
    const checkResult = await pool.query(
      `SELECT * FROM productionPlans WHERE id = $1`,
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "Plan not found" });
    }

    // Update the plan
    const result = await pool.query(
      `UPDATE productionPlans 
       SET product_name = $1,
           process_type = $2,
           description = $3,
           quantity = $4,
           priority = $5,
           shift = $6,
           start_date = $7,
           end_date = $8,
           assigned_operator = $9,
           assigned_machine = $10,
           notes = $11,
           status = COALESCE($12, status),
           progress = COALESCE($13, progress),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $14
       RETURNING *`,
      [
        product_name,
        process_type,
        description,
        quantity,
        priority,
        shift,
        start_date,
        end_date,
        assigned_operator,
        assigned_machine,
        notes,
        status,
        progress,
        id,
      ]
    );

    res.status(200).json({
      message: "Plan updated successfully",
      plan: result.rows[0],
    });
  } catch (err) {
    console.error("Error updating plan:", err.message);
    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

module.exports = router;
