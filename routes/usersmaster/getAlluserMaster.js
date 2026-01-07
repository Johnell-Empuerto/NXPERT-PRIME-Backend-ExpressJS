const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
require("dotenv").config();

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
  try {
    const result = await pool.query(
      `SELECT user_id, emp_id, name, age, role, department, shift, status, date_hired, contact_number, email, created_at, profile_image
       FROM Usermaster
       WHERE role <> 'Admin'
       ORDER BY name ASC`
    );

    res.json(result.rows); // return array of all users
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
