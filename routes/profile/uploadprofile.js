const express = require("express");
const router = express.Router();
const pool = require("../../db");
const multer = require("multer");
const path = require("path");

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/profile");
  },
  filename: async (req, file, cb) => {
    try {
      const userId = req.params.userId;
      const result = await pool.query(
        "SELECT emp_id FROM Usermaster WHERE user_id = $1",
        [userId]
      );
      const empId = result.rows[0]?.emp_id || "unknown";
      const ext = path.extname(file.originalname);
      cb(null, `user_${empId}_${Date.now()}${ext}`);
    } catch (err) {
      console.error(err);
      cb(null, `user_unknown_${Date.now()}${path.extname(file.originalname)}`);
    }
  },
});

// Only allow images, 2MB max
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images allowed"));
    }
    cb(null, true);
  },
}).single("image");

// POST: upload profile image
router.post("/upload/:userId", (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        // File too large
        return res.status(400).json({ error: "File size cannot exceed 2MB" });
      } else {
        return res.status(400).json({ error: err.message });
      }
    }

    try {
      const userId = req.params.userId;
      const imagePath = `/uploads/profile/${req.file.filename}`;

      // Save image path to DB
      await pool.query(
        "UPDATE Usermaster SET profile_image = $1 WHERE user_id = $2",
        [imagePath, userId]
      );

      res.json({
        message: "Profile image uploaded successfully",
        imagePath,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Upload failed" });
    }
  });
});

module.exports = router;
