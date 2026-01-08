const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");

// Apply route-specific logger middleware
router.use(routeLogger("/user-permissions"));

// Get specific user's permissions (for admin editing)
router.get("/:userId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { userId } = req.params;

  try {
    logger.route(`=== GET USER PERMISSIONS STARTED: ${userId} ===`);
    logger.debug(`Fetching permissions for user_id: ${userId}`);

    const result = await pool.query(
      `SELECT * FROM user_permissions WHERE user_id = $1 ORDER BY tab_label`,
      [userId]
    );

    const permissionCount = result.rows.length;
    logger.debug(`Found ${permissionCount} permissions for user: ${userId}`);

    if (permissionCount > 0) {
      logger.debug(
        "Sample permissions:",
        result.rows.slice(0, 3).map((p) => ({
          tab_name: p.tab_name,
          tab_label: p.tab_label,
          is_allowed: p.is_allowed,
        }))
      );
    }

    logger.route(`=== GET USER PERMISSIONS COMPLETED: ${userId} ===`);
    logger.info(`Returned ${permissionCount} permissions for user: ${userId}`);

    res.json(result.rows);
  } catch (err) {
    logger.error("Get permissions error", {
      error: err.message,
      user_id: userId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Failed to get permissions" });
  }
});

// Update user permissions (admin only)
router.put("/:userId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { userId } = req.params;
  const { permissions } = req.body;

  try {
    logger.route(`=== UPDATE PERMISSIONS STARTED: ${userId} ===`);
    logger.debug("Update request received", {
      user_id: userId,
      permissions_count: permissions ? permissions.length : 0,
      updating_admin: req.user?.name || req.user?.emp_id,
    });

    if (permissions && permissions.length > 0) {
      logger.debug("First permission structure:", {
        tab_name: permissions[0].tab_name,
        tab_label: permissions[0].tab_label,
        tab_path: permissions[0].tab_path,
        is_allowed: permissions[0].is_allowed,
        has_all_keys: Object.keys(permissions[0]),
      });
    }

    // Validate permissions array
    if (!Array.isArray(permissions)) {
      logger.warn("Permissions update failed: Not an array", {
        received_type: typeof permissions,
        received_data: req.body,
      });
      return res.status(400).json({
        error: "Permissions must be an array",
        received: typeof permissions,
        receivedData: req.body,
      });
    }

    if (permissions.length === 0) {
      logger.warn("Permissions update: Empty array received");
      return res.json({ success: true, message: "No permissions to update" });
    }

    // Start transaction
    logger.debug("Starting database transaction");
    await pool.query("BEGIN");

    try {
      // Delete existing permissions for this user
      logger.debug("Deleting existing permissions");
      const deleteResult = await pool.query(
        "DELETE FROM user_permissions WHERE user_id = $1",
        [userId]
      );

      logger.debug(`Deleted ${deleteResult.rowCount} existing permissions`);

      // Prepare batch insert
      const insertValues = [];
      const insertPlaceholders = [];

      logger.debug(`Processing ${permissions.length} new permissions`);

      for (let i = 0; i < permissions.length; i++) {
        const perm = permissions[i];
        const tabName = perm.tab_name;
        const tabLabel = perm.tab_label;
        const tabPath = perm.tab_path;
        const isAllowed =
          perm.is_allowed !== undefined ? perm.is_allowed : true;

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

        // Track allowed/denied counts
        if (i === 0) {
          logger.debug(`First permission validated: ${tabLabel} (${tabName})`);
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

      logger.debug("Executing batch insert query");
      const insertResult = await pool.query(insertQuery, insertValues);

      const allowedCount = permissions.filter((p) => p.is_allowed).length;
      const deniedCount = permissions.length - allowedCount;

      logger.debug("Insert completed", {
        inserted_count: insertResult.rows.length,
        allowed_permissions: allowedCount,
        denied_permissions: deniedCount,
      });

      await pool.query("COMMIT");
      logger.debug("Transaction committed successfully");

      logger.route(`=== UPDATE PERMISSIONS COMPLETED: ${userId} ===`);
      logger.info(`Permissions updated for user: ${userId}`, {
        total_permissions: permissions.length,
        allowed: allowedCount,
        denied: deniedCount,
        updated_by: req.user?.name || req.user?.emp_id,
      });

      res.json({
        success: true,
        message: "Permissions updated successfully",
        updatedCount: permissions.length,
        allowed: allowedCount,
        denied: deniedCount,
      });
    } catch (insertErr) {
      await pool.query("ROLLBACK");
      logger.error("Transaction rolled back", {
        error: insertErr.message,
        user_id: userId,
        stack: insertErr.stack,
      });
      throw insertErr;
    }
  } catch (err) {
    logger.error("Update permissions failed", {
      error: err.message,
      user_id: userId,
      permissions_count: permissions ? permissions.length : 0,
      stack: err.stack,
    });

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
  const logger = req.logger;
  const userId = req.user.user_id;

  try {
    logger.route(`=== GET MY TABS STARTED: ${userId} ===`);
    logger.debug(
      `Fetching accessible tabs for user: ${userId} (${
        req.user.name || req.user.emp_id
      })`
    );

    const result = await pool.query(
      `SELECT tab_name, tab_label, tab_path 
       FROM user_permissions 
       WHERE user_id = $1 AND is_allowed = true
       ORDER BY tab_label`,
      [userId]
    );

    const permissionCount = result.rows.length;
    logger.debug(`Found ${permissionCount} custom permissions for user`);

    // If no custom permissions, return all tabs (default behavior)
    if (permissionCount === 0) {
      logger.debug("No custom permissions found - returning all default tabs");
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

      logger.route(`=== GET MY TABS COMPLETED: ${userId} ===`);
      logger.info(
        `Returned ${allTabs.length} default tabs for user: ${userId}`
      );

      res.json(allTabs);
    } else {
      logger.debug("Returning custom permissions", {
        tabs_found: permissionCount,
        sample_tabs: result.rows.slice(0, 3).map((t) => t.tab_label),
      });

      logger.route(`=== GET MY TABS COMPLETED: ${userId} ===`);
      logger.info(
        `Returned ${permissionCount} custom tabs for user: ${userId}`
      );

      res.json(result.rows);
    }
  } catch (err) {
    logger.error("Get my tabs error", {
      error: err.message,
      user_id: userId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Failed to get accessible tabs" });
  }
});

module.exports = router;
