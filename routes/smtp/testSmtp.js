const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const nodemailer = require("nodemailer");
const router = express.Router();

// Apply route-specific logger middleware
router.use(routeLogger("/settings/test-smtp"));

router.post("/", async (req, res) => {
  const logger = req.logger;

  const {
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpSecure,
    smtpFromEmail,
    smtpFromName,
  } = req.body;

  try {
    logger.route("=== SMTP TEST STARTED ===");
    logger.debug("SMTP test request received", {
      smtpHost: smtpHost ? `${smtpHost.substring(0, 15)}...` : "empty",
      smtpPort: smtpPort,
      smtpUser: smtpUser ? `${smtpUser.substring(0, 10)}...` : "empty",
      has_smtpPass: !!smtpPass,
      smtpSecure: smtpSecure,
      smtpFromEmail: smtpFromEmail,
      smtpFromName: smtpFromName,
    });

    // Basic validation
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      const missingFields = [];
      if (!smtpHost) missingFields.push("smtpHost");
      if (!smtpPort) missingFields.push("smtpPort");
      if (!smtpUser) missingFields.push("smtpUser");
      if (!smtpPass) missingFields.push("smtpPass");

      logger.warn("SMTP test failed: Missing required fields", {
        missing_fields: missingFields,
      });

      return res.status(400).json({
        success: false,
        message: "Missing required SMTP fields",
        missing_fields: missingFields,
      });
    }

    logger.debug("Creating nodemailer transporter");
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
    logger.debug("Verifying SMTP connection");
    try {
      await transporter.verify();
      logger.debug("SMTP connection verified successfully");
    } catch (verifyErr) {
      logger.error("SMTP connection verification failed", {
        error: verifyErr.message,
        host: smtpHost,
        port: smtpPort,
        user: smtpUser,
      });
      throw verifyErr;
    }

    // Send test email
    logger.debug("Sending test email");
    const mailOptions = {
      from: `"${smtpFromName || "System"}" <${smtpFromEmail || smtpUser}>`,
      to: smtpUser,
      subject: "SMTP Test Successful",
      text: "Your SMTP configuration is working correctly.",
    };

    logger.debug("Test email configuration", {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
    });

    try {
      const info = await transporter.sendMail(mailOptions);
      logger.debug("Test email sent successfully", {
        messageId: info.messageId,
        response: info.response,
      });
    } catch (sendErr) {
      logger.error("Failed to send test email", {
        error: sendErr.message,
        from: mailOptions.from,
        to: mailOptions.to,
      });
      throw sendErr;
    }

    logger.route("=== SMTP TEST COMPLETED SUCCESSFULLY ===");
    logger.info("SMTP test completed successfully", {
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
    });

    res.json({
      success: true,
      message: "SMTP connection successful",
    });
  } catch (err) {
    logger.error("SMTP test failed", {
      error: err.message,
      error_code: err.code,
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      stack: err.stack,
    });

    // Provide more specific error messages based on error type
    let userMessage = err.message;

    if (err.code === "ECONNREFUSED") {
      userMessage = `Connection refused to ${smtpHost}:${smtpPort}. Check if server is running and firewall allows connections.`;
    } else if (err.code === "ETIMEDOUT") {
      userMessage = `Connection timeout to ${smtpHost}:${smtpPort}. Server may be unreachable or slow.`;
    } else if (err.message.includes("Invalid login")) {
      userMessage =
        "Invalid username or password. Check your SMTP credentials.";
    } else if (err.message.includes("Authentication failed")) {
      userMessage =
        "Authentication failed. Check if 'Less secure app access' is enabled for Gmail accounts.";
    }

    logger.debug("Translated error message for user", {
      original: err.message,
      translated: userMessage,
    });

    res.status(500).json({
      success: false,
      message: userMessage,
      error_code: err.code || "UNKNOWN_ERROR",
    });
  }
});

module.exports = router;
