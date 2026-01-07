// routes/settings.js
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");
require("dotenv").config();

// Enable CORS only for this route
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"], // React dev server
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// POST: Save SMTP settings
// POST: Save SMTP settings
router.post("/save-smtp", auth, isAdmin, async (req, res) => {
  let {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass, // May be empty string if user doesn't want to change
    smtpSecure,
    smtpFromEmail,
    smtpFromName,
  } = req.body;

  const secureBool = smtpSecure === true || smtpSecure === "true";

  try {
    // First, check if row exists
    const checkResult = await pool.query(
      "SELECT smtpPass FROM AppSettings WHERE id = 1"
    );
    let currentPass = null;

    if (checkResult.rows.length > 0) {
      currentPass = checkResult.rows[0].smtpPass;
    }

    // If password field is empty or just whitespace → keep old password
    if (!smtpPass || smtpPass.trim() === "") {
      smtpPass = currentPass; // Keep existing password
    }

    // Use PostgreSQL UPSERT (INSERT ... ON CONFLICT ... DO UPDATE)
    const query = `
      INSERT INTO AppSettings (
        id, smtpHost, smtpPort, smtpUser, smtpPass,
        smtpSecure, smtpFromEmail, smtpFromName
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        smtpHost = EXCLUDED.smtpHost,
        smtpPort = EXCLUDED.smtpPort,
        smtpUser = EXCLUDED.smtpUser,
        smtpPass = EXCLUDED.smtpPass,
        smtpSecure = EXCLUDED.smtpSecure,
        smtpFromEmail = EXCLUDED.smtpFromEmail,
        smtpFromName = EXCLUDED.smtpFromName
    `;

    const values = [
      smtpHost || null,
      smtpPort ? Number(smtpPort) : null,
      smtpUser || null,
      smtpPass, // Already handled: keeps old if blank
      secureBool,
      smtpFromEmail || null,
      smtpFromName || null,
    ];

    await pool.query(query, values);

    // Fetch and return the saved settings
    const savedResult = await pool.query(`
      SELECT 
        smtpHost, smtpPort, smtpUser, 
        smtpFromEmail, smtpFromName, smtpSecure
      FROM AppSettings 
      WHERE id = 1
    `);

    let savedSettings = {
      smtpHost: "",
      smtpPort: "",
      smtpUser: "",
      smtpFromEmail: "",
      smtpFromName: "",
      smtpSecure: false,
    };

    if (savedResult.rows.length > 0) {
      const row = savedResult.rows[0];
      savedSettings = {
        smtpHost: row.smtphost || "",
        smtpPort: row.smtpport ? String(row.smtpport) : "",
        smtpUser: row.smtpuser || "",
        smtpFromEmail: row.smtpfromemail || "",
        smtpFromName: row.smtpfromname || "",
        smtpSecure: row.smtpsecure || false,
      };
    }

    res.json({
      success: true,
      message: "SMTP settings saved successfully",
      settings: savedSettings, // Return the saved settings
    });
  } catch (err) {
    console.error("Save SMTP Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save settings: " + err.message,
    });
  }
});

// GET: Load current SMTP settings (without password)
router.get("/get-smtp", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        smtpHost, smtpPort, smtpUser, smtpFromEmail, smtpFromName, smtpSecure
      FROM AppSettings 
      WHERE id = 1
    `);

    let settings = {
      smtpHost: "",
      smtpPort: "",
      smtpUser: "",
      smtpFromEmail: "",
      smtpFromName: "",
      smtpSecure: false,
    };

    if (result.rows.length > 0) {
      const row = result.rows[0];
      settings = {
        smtpHost: row.smtphost || "",
        smtpPort: row.smtpport ? row.smtpport.toString() : "",
        smtpUser: row.smtpuser || "",
        smtpFromEmail: row.smtpfromemail || "",
        smtpFromName: row.smtpfromname || "",
        smtpSecure: row.smtpsecure || false,
      };
    }

    res.json({ success: true, settings });
  } catch (err) {
    console.error("Load SMTP Error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to load settings" });
  }
});

module.exports = router;
