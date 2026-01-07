const express = require("express");
const router = express.Router();
const pool = require("../../db");
const cors = require("cors");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
require("dotenv").config();

// Enable CORS
router.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Store verification codes temporarily (in production, use Redis or database)
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

  if (!empId) {
    return res.status(400).json({
      success: false,
      message: "Employee ID is required",
    });
  }

  try {
    // Check if employee exists and has email
    const userResult = await pool.query(
      "SELECT * FROM Usermaster WHERE emp_id = $1",
      [empId]
    );

    if (userResult.rows.length === 0) {
      return res.json({
        success: false,
        message: "Employee ID not found",
      });
    }

    const user = userResult.rows[0];

    if (!user.email) {
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

    res.json({
      success: true,
      message: "Verification code sent to your email",
      email: user.email, // Return masked email for display
    });
  } catch (err) {
    console.error("Request reset error:", err);

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

// Step 2: Verify code and reset password
// Step 2: Verify code only
router.post("/verify-code", async (req, res) => {
  const { empId, verificationCode } = req.body;

  if (!empId || !verificationCode) {
    return res.status(400).json({
      success: false,
      message: "Employee ID and verification code are required",
    });
  }

  try {
    // Get stored verification data
    const storedData = verificationCodes.get(empId);

    if (!storedData) {
      return res.json({
        success: false,
        message:
          "No verification code found or code expired. Please request a new one.",
      });
    }

    // Check if code expired
    if (Date.now() > storedData.expiresAt) {
      verificationCodes.delete(empId);
      return res.json({
        success: false,
        message: "Verification code has expired. Please request a new one.",
      });
    }

    // Verify code
    if (storedData.code !== verificationCode) {
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

    res.json({
      success: true,
      message: "Code verified successfully",
    });
  } catch (err) {
    console.error("Verify code error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to verify code. Please try again.",
    });
  }
});

// Step 3: Reset password after verification
router.post("/reset-password", async (req, res) => {
  const { empId, verificationCode, newPassword } = req.body;

  if (!empId || !verificationCode || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "All fields are required",
    });
  }

  if (newPassword.length < 6) {
    return res.json({
      success: false,
      message: "Password must be at least 6 characters long",
    });
  }

  try {
    // Get stored verification data
    const storedData = verificationCodes.get(empId);

    if (!storedData) {
      return res.json({
        success: false,
        message: "Verification session expired. Please start over.",
      });
    }

    // Check if code expired
    if (Date.now() > storedData.expiresAt) {
      verificationCodes.delete(empId);
      return res.json({
        success: false,
        message: "Verification code has expired. Please request a new one.",
      });
    }

    // Verify code again
    if (storedData.code !== verificationCode) {
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

    // Send confirmation email
    try {
      const smtpSettings = await getSmtpSettings();
      const transporter = nodemailer.createTransport({
        host: smtpSettings.smtphost,
        port: smtpSettings.smtpport,
        secure: smtpSettings.smtpsecure,
        auth: {
          user: smtpSettings.smtpuser,
          pass: smtpSettings.smtppass,
        },
      });

      await transporter.sendMail({
        from: `"${smtpSettings.smtpfromname || "NXPERT EON"}" <${
          smtpSettings.smtpfromemail || smtpSettings.smtpuser
        }>`,
        to: storedData.email,
        subject: "Password Reset Successful",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Password Reset Successful</h2>
            <p>Hello,</p>
            <p>Your NXPERT EON account password has been successfully reset.</p>
            <div style="background-color: #f0fdf4; padding: 15px; border-left: 4px solid #22c55e; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #166534;">✓ Password reset completed at ${new Date().toLocaleString()}</p>
            </div>
            <p>If you did not perform this action, please contact your system administrator immediately.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="color: #6b7280; font-size: 12px;">
              This is an automated message from NXPERT EON System.
            </p>
          </div>
        `,
      });
    } catch (emailError) {
      console.error("Failed to send confirmation email:", emailError);
      // Continue even if email fails - password is still reset
    }

    res.json({
      success: true,
      message: "Password reset successfully!",
    });
  } catch (err) {
    console.error("Reset password error:", err);
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
