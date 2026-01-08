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
router.use(routeLogger("/production/plans"));

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
  const logger = req.logger;

  try {
    logger.route("=== GET ALL PRODUCTION PLANS STARTED ===");
    logger.debug("Fetching all production plans from database");

    const result = await pool.query(
      `SELECT * FROM productionPlans ORDER BY start_date DESC`
    );

    const planCount = result.rows.length;
    logger.debug(`Retrieved ${planCount} production plans`);

    if (planCount > 0) {
      const samplePlans = result.rows.slice(0, 3).map((plan) => ({
        id: plan.id,
        product_name: plan.product_name,
        process_type: plan.process_type,
        status: plan.status,
        start_date: plan.start_date,
      }));
      logger.debug("Sample plans retrieved:", samplePlans);
    }

    logger.route("=== GET ALL PRODUCTION PLANS COMPLETED ===");
    logger.info(
      `Returned ${planCount} production plans to user: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.status(200).json(result.rows);
  } catch (err) {
    logger.error("Error fetching production plans", {
      error: err.message,
      user_id: req.user?.user_id,
      user_name: req.user?.name,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// GET - Fetch plans by date range (optional)
router.get("/range", auth, async (req, res) => {
  const logger = req.logger;
  const { startDate, endDate } = req.query;

  try {
    logger.route("=== GET PLANS BY DATE RANGE STARTED ===");
    logger.debug("Fetching plans by date range", {
      startDate: startDate,
      endDate: endDate,
      user: req.user?.name || req.user?.emp_id,
    });

    let query = `SELECT * FROM productionPlans`;
    let params = [];

    if (startDate && endDate) {
      query += ` WHERE start_date >= $1 AND end_date <= $2 ORDER BY start_date`;
      params = [startDate, endDate];
      logger.debug("Using date range filter", { startDate, endDate });
    } else {
      query += ` ORDER BY start_date DESC`;
      logger.debug("No date range provided - fetching all plans");
    }

    logger.debug("Executing query:", { query, params });
    const result = await pool.query(query, params);

    const planCount = result.rows.length;
    logger.debug(`Retrieved ${planCount} plans matching criteria`);

    if (planCount > 0 && startDate && endDate) {
      logger.debug("Date range results summary", {
        earliest_start: result.rows[0]?.start_date,
        latest_end: result.rows[result.rows.length - 1]?.end_date,
      });
    }

    logger.route("=== GET PLANS BY DATE RANGE COMPLETED ===");
    logger.info(
      `Returned ${planCount} plans for date range to user: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.status(200).json(result.rows);
  } catch (err) {
    logger.error("Error fetching plans by range", {
      error: err.message,
      startDate: startDate,
      endDate: endDate,
      user: req.user?.name || req.user?.emp_id,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// GET - Fetch plan by ID
router.get("/:id", auth, async (req, res) => {
  const logger = req.logger;
  const { id } = req.params;

  try {
    logger.route(`=== GET PLAN BY ID STARTED: ${id} ===`);
    logger.debug(`Fetching production plan with ID: ${id}`);

    const result = await pool.query(
      `SELECT * FROM productionPlans WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      logger.warn(`Production plan not found with ID: ${id}`);
      return res.status(404).json({ error: "Plan not found" });
    }

    const plan = result.rows[0];
    logger.debug("Plan found:", {
      id: plan.id,
      product_name: plan.product_name,
      process_type: plan.process_type,
      status: plan.status,
      progress: plan.progress,
    });

    logger.route(`=== GET PLAN BY ID COMPLETED: ${id} ===`);
    logger.info(
      `Plan ${id} retrieved successfully by user: ${
        req.user?.name || req.user?.emp_id
      }`
    );

    res.status(200).json(plan);
  } catch (err) {
    logger.error("Error fetching plan by ID", {
      error: err.message,
      plan_id: id,
      user: req.user?.name || req.user?.emp_id,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// POST - Adding a Plan
router.post("/", auth, isAdmin, async (req, res) => {
  const logger = req.logger;

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

  try {
    logger.route("=== ADD PRODUCTION PLAN STARTED ===");
    logger.debug("New plan request received", {
      product_name: product_name,
      process_type: process_type,
      quantity: quantity,
      assigned_operator: assigned_operator,
      assigned_machine: assigned_machine,
      created_by: req.user?.name || req.user?.emp_id,
    });

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
      const missingFields = [];
      if (!product_name) missingFields.push("product_name");
      if (!process_type) missingFields.push("process_type");
      if (!quantity) missingFields.push("quantity");
      if (!priority) missingFields.push("priority");
      if (!shift) missingFields.push("shift");
      if (!start_date) missingFields.push("start_date");
      if (!end_date) missingFields.push("end_date");
      if (!assigned_operator) missingFields.push("assigned_operator");
      if (!assigned_machine) missingFields.push("assigned_machine");

      logger.warn("Plan creation failed: Missing required fields", {
        missing_fields: missingFields,
        created_by: req.user?.name || req.user?.emp_id,
      });

      return res.status(400).json({
        error:
          "Product Name, Process Type, Quantity, Priority, Shift, Start Date, End Date, Assigned Operator, and Assigned Machine are required",
        missing_fields: missingFields,
      });
    }

    logger.debug("Inserting new production plan into database");
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

    const newPlan = result.rows[0];
    logger.debug("Production plan created successfully", {
      plan_id: newPlan.id,
      product_name: newPlan.product_name,
      priority: newPlan.priority,
      start_date: newPlan.start_date,
      end_date: newPlan.end_date,
    });

    logger.route("=== ADD PRODUCTION PLAN COMPLETED ===");
    logger.info("New production plan created", {
      plan_id: newPlan.id,
      product_name: newPlan.product_name,
      created_by: req.user?.name || req.user?.emp_id,
    });

    res.status(201).json({
      message: "Plan added successfully",
      plan_id: newPlan.id,
    });
  } catch (err) {
    logger.error("Error adding production plan", {
      error: err.message,
      product_name: product_name,
      process_type: process_type,
      created_by: req.user?.name || req.user?.emp_id,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

// PUT - Update a production plan
router.put("/:id", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
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

  try {
    logger.route(`=== UPDATE PRODUCTION PLAN STARTED: ${id} ===`);
    logger.debug("Update request received", {
      plan_id: id,
      product_name: product_name,
      process_type: process_type,
      status: status,
      progress: progress,
      updated_by: req.user?.name || req.user?.emp_id,
    });

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
      const missingFields = [];
      if (!product_name) missingFields.push("product_name");
      if (!process_type) missingFields.push("process_type");
      if (!quantity) missingFields.push("quantity");
      if (!priority) missingFields.push("priority");
      if (!shift) missingFields.push("shift");
      if (!start_date) missingFields.push("start_date");
      if (!end_date) missingFields.push("end_date");
      if (!assigned_operator) missingFields.push("assigned_operator");
      if (!assigned_machine) missingFields.push("assigned_machine");

      logger.warn("Plan update failed: Missing required fields", {
        plan_id: id,
        missing_fields: missingFields,
        updated_by: req.user?.name || req.user?.emp_id,
      });

      return res.status(400).json({
        error:
          "Product Name, Process Type, Quantity, Priority, Shift, Start Date, End Date, Assigned Operator, and Assigned Machine are required",
        missing_fields: missingFields,
      });
    }

    // First, check if plan exists
    logger.debug("Checking if plan exists in database");
    const checkResult = await pool.query(
      `SELECT * FROM productionPlans WHERE id = $1`,
      [id]
    );

    if (checkResult.rows.length === 0) {
      logger.warn(`Plan not found for update: ${id}`);
      return res.status(404).json({ error: "Plan not found" });
    }

    const existingPlan = checkResult.rows[0];
    logger.debug("Existing plan found", {
      current_status: existingPlan.status,
      current_progress: existingPlan.progress,
    });

    // Update the plan
    logger.debug("Updating production plan in database");
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

    const updatedPlan = result.rows[0];

    // Log what changed
    const changes = [];
    if (existingPlan.status !== updatedPlan.status)
      changes.push(`status: ${existingPlan.status} → ${updatedPlan.status}`);
    if (existingPlan.progress !== updatedPlan.progress)
      changes.push(
        `progress: ${existingPlan.progress} → ${updatedPlan.progress}`
      );
    if (existingPlan.quantity !== updatedPlan.quantity)
      changes.push(
        `quantity: ${existingPlan.quantity} → ${updatedPlan.quantity}`
      );

    logger.debug("Plan updated successfully", {
      plan_id: updatedPlan.id,
      changes: changes.length > 0 ? changes : ["minor updates"],
    });

    logger.route(`=== UPDATE PRODUCTION PLAN COMPLETED: ${id} ===`);
    logger.info("Production plan updated", {
      plan_id: updatedPlan.id,
      product_name: updatedPlan.product_name,
      updated_by: req.user?.name || req.user?.emp_id,
      status_change: existingPlan.status !== updatedPlan.status,
    });

    res.status(200).json({
      message: "Plan updated successfully",
      plan: updatedPlan,
      changes: changes,
    });
  } catch (err) {
    logger.error("Error updating production plan", {
      error: err.message,
      plan_id: id,
      updated_by: req.user?.name || req.user?.emp_id,
      stack: err.stack,
    });

    res.status(500).json({
      error: "Database error: " + err.message,
    });
  }
});

module.exports = router;
