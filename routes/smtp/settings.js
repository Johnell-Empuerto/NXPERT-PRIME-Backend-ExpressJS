const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");
require("dotenv").config();

// Apply route-specific logger middleware
router.use(routeLogger("/settings/smtp"));

// Enable CORS only for this route
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// POST: Save SMTP settings
router.post("/save-smtp", auth, isAdmin, async (req, res) => {
  const logger = req.logger;

  let {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass, // May be empty string if user doesn't want to change
    smtpSecure,
    smtpFromEmail,
    smtpFromName,
  } = req.body;

  try {
    logger.route("=== SAVE SMTP SETTINGS STARTED ===");
    logger.debug("Save SMTP request received", {
      updating_admin: req.user?.name || req.user?.emp_id,
      has_smtpPass: !!smtpPass,
      smtpHost: smtpHost ? `${smtpHost.substring(0, 10)}...` : "empty",
      smtpPort: smtpPort,
      smtpSecure: smtpSecure,
    });

    const secureBool = smtpSecure === true || smtpSecure === "true";
    logger.debug(`Converted smtpSecure: ${smtpSecure} → ${secureBool}`);

    // First, check if row exists
    logger.debug("Checking if SMTP settings already exist in database");
    const checkResult = await pool.query(
      "SELECT smtpPass FROM AppSettings WHERE id = 1"
    );
    let currentPass = null;

    if (checkResult.rows.length > 0) {
      currentPass = checkResult.rows[0].smtpPass;
      logger.debug("Existing settings found in database");
    } else {
      logger.debug("No existing settings found - will create new record");
    }

    // If password field is empty or just whitespace → keep old password
    if (!smtpPass || smtpPass.trim() === "") {
      smtpPass = currentPass; // Keep existing password
      logger.debug("Password field empty - keeping existing password");
    } else {
      logger.debug("New password provided - will update password");
    }

    // Use PostgreSQL UPSERT
    logger.debug("Preparing UPSERT query for SMTP settings");
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

    logger.debug("Executing database UPSERT query");
    await pool.query(query, values);
    logger.debug("SMTP settings saved to database successfully");

    // Fetch and return the saved settings
    logger.debug("Fetching saved settings for response");
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

      logger.debug("Retrieved saved settings", {
        smtpHost: savedSettings.smtpHost
          ? `${savedSettings.smtpHost.substring(0, 10)}...`
          : "empty",
        smtpPort: savedSettings.smtpPort,
        smtpUser: savedSettings.smtpUser
          ? `${savedSettings.smtpUser.substring(0, 5)}...`
          : "empty",
        has_fromEmail: !!savedSettings.smtpFromEmail,
        has_fromName: !!savedSettings.smtpFromName,
      });
    }

    logger.route("=== SAVE SMTP SETTINGS COMPLETED ===");
    logger.info("SMTP settings saved successfully", {
      updated_by: req.user?.name || req.user?.emp_id,
      smtpHost_set: !!savedSettings.smtpHost,
      smtpUser_set: !!savedSettings.smtpUser,
    });

    res.json({
      success: true,
      message: "SMTP settings saved successfully",
      settings: savedSettings,
    });
  } catch (err) {
    logger.error("Save SMTP settings failed", {
      error: err.message,
      updating_admin: req.user?.name || req.user?.emp_id,
      stack: err.stack,
      smtpHost: smtpHost,
      smtpPort: smtpPort,
      smtpUser: smtpUser,
    });

    res.status(500).json({
      success: false,
      message: "Failed to save settings: " + err.message,
    });
  }
});

// GET: Load current SMTP settings (without password)
router.get("/get-smtp", async (req, res) => {
  const logger = req.logger;

  try {
    logger.route("=== GET SMTP SETTINGS STARTED ===");
    logger.debug("Fetching SMTP settings from database");

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

      logger.debug("SMTP settings found in database", {
        has_smtpHost: !!settings.smtpHost,
        has_smtpUser: !!settings.smtpUser,
        smtpPort: settings.smtpPort,
        smtpSecure: settings.smtpSecure,
        has_fromEmail: !!settings.smtpFromEmail,
        has_fromName: !!settings.smtpFromName,
      });
    } else {
      logger.warn(
        "No SMTP settings found in database - returning empty defaults"
      );
    }

    logger.route("=== GET SMTP SETTINGS COMPLETED ===");
    logger.info("SMTP settings retrieved successfully");

    res.json({ success: true, settings });
  } catch (err) {
    logger.error("Load SMTP settings failed", {
      error: err.message,
      stack: err.stack,
    });

    res
      .status(500)
      .json({ success: false, message: "Failed to load settings" });
  }
});

module.exports = router;
