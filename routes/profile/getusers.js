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

// GET user by ID
router.get("/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      "SELECT user_id, emp_id, name, age, role, department, shift, status, date_hired, contact_number, email, created_at, profile_image FROM Usermaster WHERE user_id = $1",
      [userId]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
