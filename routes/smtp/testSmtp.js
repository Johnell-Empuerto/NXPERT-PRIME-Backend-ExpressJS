const express = require("express");
const nodemailer = require("nodemailer");

const router = express.Router();

router.post("/", async (req, res) => {
  const {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpSecure,
    smtpFromEmail,
    smtpFromName,
  } = req.body;

  // Basic validation
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    return res.status(400).json({
      success: false,
      message: "Missing required SMTP fields",
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(smtpPort),
      secure: smtpSecure, // false for 587
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    // Verify SMTP connection
    await transporter.verify();

    // Send test email
    await transporter.sendMail({
      from: `"${smtpFromName || "System"}" <${smtpFromEmail || smtpUser}>`,
      to: smtpUser,
      subject: "SMTP Test Successful",
      text: "Your SMTP configuration is working correctly.",
    });

    res.json({
      success: true,
      message: "SMTP connection successful",
    });
  } catch (err) {
    console.error("SMTP ERROR:", err.message);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;
