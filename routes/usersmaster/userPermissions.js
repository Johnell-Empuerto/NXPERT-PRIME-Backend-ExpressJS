// routes/userPermissions.js
const express = require("express");
const router = express.Router();
const pool = require("../../db"); // Adjust path as needed
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");

// Get specific user's permissions (for admin editing)
router.get("/:userId", auth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT * FROM user_permissions WHERE user_id = $1 ORDER BY tab_label`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Get permissions error:", err);
    res.status(500).json({ error: "Failed to get permissions" });
  }
});

// Update user permissions (admin only)
router.put("/:userId", auth, isAdmin, async (req, res) => {
  console.log("=== UPDATE PERMISSIONS START ===");
  console.log("User ID:", req.params.userId);
  console.log("Request body received:", JSON.stringify(req.body, null, 2));

  try {
    const { userId } = req.params;
    const { permissions } = req.body;

    console.log(
      "Permissions array length:",
      permissions ? permissions.length : 0
    );

    // Validate permissions array
    if (!Array.isArray(permissions)) {
      console.error("Permissions is not an array:", permissions);
      return res.status(400).json({
        error: "Permissions must be an array",
        received: typeof permissions,
        receivedData: req.body,
      });
    }

    if (permissions.length === 0) {
      console.log("No permissions to update");
      return res.json({ success: true, message: "No permissions to update" });
    }

    // Debug: Log first permission to see structure
    console.log("First permission object structure:", permissions[0]);
    console.log("First permission keys:", Object.keys(permissions[0]));

    // Start transaction
    await pool.query("BEGIN");

    try {
      // Delete existing permissions for this user
      console.log("Deleting existing permissions for user:", userId);
      const deleteResult = await pool.query(
        "DELETE FROM user_permissions WHERE user_id = $1",
        [userId]
      );
      console.log("Deleted rows:", deleteResult.rowCount);

      // Insert new permissions using batch insert for better performance
      const insertValues = [];
      const insertPlaceholders = [];

      for (let i = 0; i < permissions.length; i++) {
        const perm = permissions[i];

        // Extract values - frontend is sending snake_case: tab_name, tab_label, tab_path, is_allowed
        const tabName = perm.tab_name;
        const tabLabel = perm.tab_label;
        const tabPath = perm.tab_path;
        const isAllowed =
          perm.is_allowed !== undefined ? perm.is_allowed : true;

        console.log(`Permission ${i + 1}:`, {
          tabName,
          tabLabel,
          tabPath,
          isAllowed,
        });

        // Validate required fields
        if (!tabName || tabName.trim() === "") {
          throw new Error(`Permission ${i + 1} has empty tab_name`);
        }
        if (!tabLabel || tabLabel.trim() === "") {
          throw new Error(`Permission ${i + 1} has empty tab_label`);
        }
        if (!tabPath || tabPath.trim() === "") {
          throw new Error(`Permission ${i + 1} has empty tab_path`);
        }

        // Add to values array for batch insert
        const base = i * 5;
        insertValues.push(userId, tabName, tabLabel, tabPath, isAllowed);
        insertPlaceholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${
            base + 5
          })`
        );
      }

      // Batch insert all permissions at once
      const insertQuery = `
        INSERT INTO user_permissions 
        (user_id, tab_name, tab_label, tab_path, is_allowed) 
        VALUES ${insertPlaceholders.join(", ")} 
        RETURNING id
      `;

      console.log("Batch insert query values:", insertValues);
      const insertResult = await pool.query(insertQuery, insertValues);
      console.log(
        `Successfully inserted ${insertResult.rows.length} permissions`
      );

      await pool.query("COMMIT");

      console.log("=== UPDATE PERMISSIONS SUCCESS ===");
      res.json({
        success: true,
        message: "Permissions updated successfully",
        updatedCount: permissions.length,
      });
    } catch (insertErr) {
      await pool.query("ROLLBACK");
      console.error("=== TRANSACTION ROLLED BACK ===");
      console.error("Error during transaction:", insertErr.message);
      console.error("Error stack:", insertErr.stack);
      throw insertErr;
    }
  } catch (err) {
    console.error("=== UPDATE PERMISSIONS FAILED ===");
    console.error("Error:", err.message);
    console.error("Full error:", err);

    res.status(500).json({
      error: "Failed to update permissions",
      message: err.message,
      details: err.detail || err.code || err.toString(),
      receivedData: req.body,
    });
  }
});

// Get current user's accessible tabs (for sidebar)
router.get("/me/tabs", auth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    console.log("Fetching tabs for user:", userId);

    const result = await pool.query(
      `SELECT tab_name, tab_label, tab_path 
       FROM user_permissions 
       WHERE user_id = $1 AND is_allowed = true
       ORDER BY tab_label`,
      [userId]
    );

    console.log("Found permissions:", result.rows.length);

    // If no custom permissions, return all tabs (default behavior)
    if (result.rows.length === 0) {
      const allTabs = [
        {
          tab_name: "planning",
          tab_label: "Production Planning",
          tab_path: "/dashboard/planning",
        },
        {
          tab_name: "tracking",
          tab_label: "Process Tracking",
          tab_path: "/dashboard/tracking",
        },
        {
          tab_name: "quality",
          tab_label: "Quality & Defects",
          tab_path: "/dashboard/quality",
        },
        {
          tab_name: "ng_rework",
          tab_label: "NG & Rework Management",
          tab_path: "/dashboard/quality/ng-rework",
        },
        {
          tab_name: "daily_report",
          tab_label: "Daily Production Report",
          tab_path: "/dashboard/reports/daily",
        },
        {
          tab_name: "monthly_report",
          tab_label: "Monthly Production Report",
          tab_path: "/dashboard/reports/monthly",
        },
        {
          tab_name: "yearly_report",
          tab_label: "Yearly Production Report",
          tab_path: "/dashboard/reports/yearly",
        },
        {
          tab_name: "analytics",
          tab_label: "Analytics & Insights",
          tab_path: "/dashboard/analytics",
        },
        {
          tab_name: "create_checksheet",
          tab_label: "Create Checksheet Templates",
          tab_path: "/dashboard/create-checksheet",
        },
        {
          tab_name: "forms",
          tab_label: "Form Checksheet",
          tab_path: "/dashboard/forms",
        },
        {
          tab_name: "usermaster",
          tab_label: "User Master",
          tab_path: "/dashboard/usermaster",
        },
      ];
      console.log("Returning all tabs (no custom permissions)");
      res.json(allTabs);
    } else {
      res.json(result.rows);
    }
  } catch (err) {
    console.error("Get my tabs error:", err);
    res.status(500).json({ error: "Failed to get accessible tabs" });
  }
});

module.exports = router;
