const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
require("dotenv").config();

// Apply route-specific logger middleware
router.use(routeLogger("/auth/forgot-password"));

// Enable CORS
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Store verification codes temporarily
const verificationCodes = new Map();

// Generate 6-digit verification code
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Get SMTP settings
const getSmtpSettings = async () => {
  try {
    const result = await pool.query("SELECT * FROM AppSettings WHERE id = 1");

    if (result.rows.length === 0) {
      throw new Error("SMTP settings not configured");
    }

    return result.rows[0];
  } catch (err) {
    console.error("Error fetching SMTP settings:", err);
    throw err;
  }
};

// Step 1: Request password reset and send verification code
router.post("/request-reset", async (req, res) => {
  const { empId } = req.body;
  const logger = req.logger || console; // Fallback to console if logger not available

  if (!empId) {
    logger.warn("Password reset request failed: Missing empId");
    return res.status(400).json({
      success: false,
      message: "Employee ID is required",
    });
  }

  try {
    logger.info(`Password reset requested for empId: ${empId}`);

    // Check if employee exists and has email
    const userResult = await pool.query(
      "SELECT * FROM Usermaster WHERE emp_id = $1",
      [empId]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`Employee ID not found: ${empId}`);
      return res.json({
        success: false,
        message: "Employee ID not found",
      });
    }

    const user = userResult.rows[0];

    if (!user.email) {
      logger.warn(`No email associated with account: ${empId}`);
      return res.json({
        success: false,
        message:
          "No email associated with this account. Please contact administrator.",
      });
    }

    // Get SMTP settings
    const smtpSettings = await getSmtpSettings();

    // Generate verification code
    const verificationCode = generateVerificationCode();

    // Store verification code (expires in 10 minutes)
    verificationCodes.set(empId, {
      code: verificationCode,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      email: user.email,
    });

    // Create email transporter
    const transporter = nodemailer.createTransport({
      host: smtpSettings.smtphost,
      port: smtpSettings.smtpport,
      secure: smtpSettings.smtpsecure,
      auth: {
        user: smtpSettings.smtpuser,
        pass: smtpSettings.smtppass,
      },
    });

    // Send verification email
    await transporter.sendMail({
      from: `"${smtpSettings.smtpfromname || "NXPERT EON"}" <${
        smtpSettings.smtpfromemail || smtpSettings.smtpuser
      }>`,
      to: user.email,
      subject: "Password Reset Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">NXPERT EON Password Reset</h2>
          <p>Hello ${user.name},</p>
          <p>You have requested to reset your password. Please use the verification code below:</p>
          <div style="background-color: #f3f4f6; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
            <h1 style="color: #2563eb; letter-spacing: 5px; margin: 0;">${verificationCode}</h1>
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this password reset, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 12px;">
            This is an automated message from NXPERT EON System.
          </p>
        </div>
      `,
    });

    logger.info(`Verification code sent to ${user.email} for empId: ${empId}`);

    res.json({
      success: true,
      message: "Verification code sent to your email",
      email: user.email,
    });
  } catch (err) {
    logger.error("Password reset request failed", {
      error: err.message,
      empId: empId,
    });

    if (err.message.includes("SMTP settings not configured")) {
      return res.status(500).json({
        success: false,
        message:
          "Email service is not configured. Please contact administrator.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to send verification code. Please try again.",
    });
  }
});

// Step 2: Verify code only
router.post("/verify-code", async (req, res) => {
  const { empId, verificationCode } = req.body;
  const logger = req.logger || console;

  if (!empId || !verificationCode) {
    logger.warn("Verification code validation failed: Missing fields");
    return res.status(400).json({
      success: false,
      message: "Employee ID and verification code are required",
    });
  }

  try {
    // Get stored verification data
    const storedData = verificationCodes.get(empId);

    if (!storedData) {
      logger.warn(`No verification code found for empId: ${empId}`);
      return res.json({
        success: false,
        message:
          "No verification code found or code expired. Please request a new one.",
      });
    }

    // Check if code expired
    if (Date.now() > storedData.expiresAt) {
      verificationCodes.delete(empId);
      logger.warn(`Verification code expired for empId: ${empId}`);
      return res.json({
        success: false,
        message: "Verification code has expired. Please request a new one.",
      });
    }

    // Verify code
    if (storedData.code !== verificationCode) {
      logger.warn(`Invalid verification code for empId: ${empId}`);
      return res.json({
        success: false,
        message: "Invalid verification code",
      });
    }

    // Mark as verified (store verification status)
    verificationCodes.set(empId, {
      ...storedData,
      verified: true,
    });

    logger.info(`Code verified successfully for empId: ${empId}`);

    res.json({
      success: true,
      message: "Code verified successfully",
    });
  } catch (err) {
    logger.error("Verify code error", {
      error: err.message,
      empId: empId,
    });

    res.status(500).json({
      success: false,
      message: "Failed to verify code. Please try again.",
    });
  }
});

// Step 3: Reset password after verification
router.post("/reset-password", async (req, res) => {
  const { empId, verificationCode, newPassword } = req.body;
  const logger = req.logger || console;

  if (!empId || !verificationCode || !newPassword) {
    logger.warn("Password reset failed: Missing required fields");
    return res.status(400).json({
      success: false,
      message: "All fields are required",
    });
  }

  if (newPassword.length < 6) {
    logger.warn("Password reset failed: Password too short");
    return res.json({
      success: false,
      message: "Password must be at least 6 characters long",
    });
  }

  try {
    // Get stored verification data
    const storedData = verificationCodes.get(empId);

    if (!storedData) {
      logger.warn(`No verification session found for empId: ${empId}`);
      return res.json({
        success: false,
        message: "Verification session expired. Please start over.",
      });
    }

    // Check if code expired
    if (Date.now() > storedData.expiresAt) {
      verificationCodes.delete(empId);
      logger.warn(`Verification code expired for empId: ${empId}`);
      return res.json({
        success: false,
        message: "Verification code has expired. Please request a new one.",
      });
    }

    // Verify code again
    if (storedData.code !== verificationCode) {
      logger.warn(`Invalid verification code for empId: ${empId}`);
      return res.json({
        success: false,
        message: "Invalid verification code",
      });
    }

    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password in database
    await pool.query("UPDATE Usermaster SET password = $1 WHERE emp_id = $2", [
      hashedPassword,
      empId,
    ]);

    // Clear verification code after successful reset
    verificationCodes.delete(empId);

    logger.info(`Password reset successful for empId: ${empId}`);

    res.json({
      success: true,
      message: "Password reset successfully!",
    });
  } catch (err) {
    logger.error("Reset password error", {
      error: err.message,
      empId: empId,
    });

    res.status(500).json({
      success: false,
      message: "Failed to reset password. Please try again.",
    });
  }
});

// Clean up expired codes periodically (optional)
setInterval(() => {
  const now = Date.now();
  for (const [empId, data] of verificationCodes.entries()) {
    if (now > data.expiresAt) {
      verificationCodes.delete(empId);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

module.exports = router;
