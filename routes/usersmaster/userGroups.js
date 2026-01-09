const routeLogger = require("../../middleware/routeLogger");
const express = require("express");
const router = express.Router();
const pool = require("../../db");
const auth = require("../../middleware/auth");
const isAdmin = require("../../middleware/isAdmin");

// Apply route-specific logger middleware
router.use(routeLogger("/user-groups"));

// Create a new group
router.post("/", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { group_name, description, color } = req.body;

  try {
    logger.route("=== CREATE USER GROUP STARTED ===");

    // Validate
    if (!group_name || group_name.trim() === "") {
      logger.warn("Group creation failed: Missing group name");
      return res.status(400).json({ error: "Group name is required" });
    }

    // Check if group already exists
    const existingGroup = await pool.query(
      "SELECT * FROM user_groups WHERE LOWER(group_name) = LOWER($1)",
      [group_name.trim()]
    );

    if (existingGroup.rows.length > 0) {
      logger.warn("Group creation failed: Group name already exists");
      return res.status(400).json({ error: "Group name already exists" });
    }

    // Create group
    const result = await pool.query(
      `INSERT INTO user_groups 
       (group_name, description, color, created_by, created_at) 
       VALUES ($1, $2, $3, $4, NOW()) 
       RETURNING *`,
      [
        group_name.trim(),
        description || null,
        color || "#3498db",
        req.user.user_id,
      ]
    );

    const newGroup = result.rows[0];

    logger.route("=== CREATE USER GROUP COMPLETED ===");
    logger.info(
      `Group created: ${newGroup.group_name} (ID: ${newGroup.group_id})`
    );

    res.status(201).json({
      message: "Group created successfully",
      group: newGroup,
    });
  } catch (err) {
    logger.error("Error creating group", {
      error: err.message,
      group_name: group_name,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Get all groups
router.get("/", auth, async (req, res) => {
  const logger = req.logger;

  try {
    logger.route("=== GET ALL GROUPS STARTED ===");

    const result = await pool.query(
      `SELECT 
        g.*,
        u.name as created_by_name,
        COUNT(ug.user_id) as user_count
       FROM user_groups g
       LEFT JOIN usermaster u ON g.created_by = u.user_id
       LEFT JOIN user_group_memberships ug ON g.group_id = ug.group_id
       WHERE g.is_active = true
       GROUP BY g.group_id, u.name
       ORDER BY g.created_at DESC`
    );

    logger.route("=== GET ALL GROUPS COMPLETED ===");
    logger.info(`Returned ${result.rows.length} groups`);

    res.json(result.rows);
  } catch (err) {
    logger.error("Error fetching groups", {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Update group
router.put("/:groupId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { groupId } = req.params;
  const { group_name, description, color, is_active } = req.body;

  try {
    logger.route(`=== UPDATE GROUP STARTED: ${groupId} ===`);

    // Check if group exists
    const groupCheck = await pool.query(
      "SELECT * FROM user_groups WHERE group_id = $1",
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      logger.warn(`Group not found: ${groupId}`);
      return res.status(404).json({ error: "Group not found" });
    }

    // Check for duplicate name (excluding current group)
    if (group_name) {
      const duplicateCheck = await pool.query(
        `SELECT * FROM user_groups 
         WHERE LOWER(group_name) = LOWER($1) AND group_id != $2`,
        [group_name.trim(), groupId]
      );

      if (duplicateCheck.rows.length > 0) {
        logger.warn("Group update failed: Group name already exists");
        return res.status(400).json({ error: "Group name already exists" });
      }
    }

    // Update group
    const updateResult = await pool.query(
      `UPDATE user_groups 
       SET group_name = COALESCE($1, group_name),
           description = COALESCE($2, description),
           color = COALESCE($3, color),
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE group_id = $5
       RETURNING *`,
      [
        group_name ? group_name.trim() : null,
        description || null,
        color || null,
        is_active !== undefined ? is_active : null,
        groupId,
      ]
    );

    const updatedGroup = updateResult.rows[0];

    logger.route(`=== UPDATE GROUP COMPLETED: ${groupId} ===`);

    res.json({
      message: "Group updated successfully",
      group: updatedGroup,
    });
  } catch (err) {
    logger.error("Error updating group", {
      error: err.message,
      group_id: groupId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Delete group (soft delete)
router.delete("/:groupId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { groupId } = req.params;

  try {
    logger.route(`=== HARD DELETE GROUP STARTED: ${groupId} ===`);

    // Check if group exists
    const groupCheck = await pool.query(
      "SELECT * FROM user_groups WHERE group_id = $1",
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      logger.warn(`Group not found: ${groupId}`);
      return res.status(404).json({ error: "Group not found" });
    }

    // First, delete all user memberships (if you don't have CASCADE foreign key)
    logger.info("Deleting group memberships...");
    await pool.query("DELETE FROM user_group_memberships WHERE group_id = $1", [
      groupId,
    ]);

    // Hard delete the group
    logger.info("Deleting group...");
    const deleteResult = await pool.query(
      "DELETE FROM user_groups WHERE group_id = $1 RETURNING group_name",
      [groupId]
    );

    const deletedGroupName = deleteResult.rows[0]?.group_name;

    logger.route(`=== HARD DELETE GROUP COMPLETED: ${groupId} ===`);
    logger.info(`Group permanently deleted: ${deletedGroupName}`);

    res.json({
      message: "Group permanently deleted",
      deletedGroup: deletedGroupName,
    });
  } catch (err) {
    logger.error("Error hard deleting group", {
      error: err.message,
      group_id: groupId,
      stack: err.stack,
    });

    // Check for foreign key constraint errors
    if (err.code === "23503") {
      // Foreign key violation
      return res.status(400).json({
        error: "Cannot delete group. Remove all users from the group first.",
      });
    }

    res.status(500).json({ error: "Database error" });
  }
});

// Add user to group
router.post("/:groupId/users/:userId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { groupId, userId } = req.params;

  try {
    logger.route(`=== ADD USER TO GROUP STARTED: ${userId} -> ${groupId} ===`);

    // Check if group exists and is active
    const groupCheck = await pool.query(
      "SELECT * FROM user_groups WHERE group_id = $1 AND is_active = true",
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      logger.warn(`Active group not found: ${groupId}`);
      return res.status(404).json({ error: "Group not found or inactive" });
    }

    // Check if user exists
    const userCheck = await pool.query(
      "SELECT * FROM usermaster WHERE user_id = $1",
      [userId]
    );

    if (userCheck.rows.length === 0) {
      logger.warn(`User not found: ${userId}`);
      return res.status(404).json({ error: "User not found" });
    }

    // Check if user is already in group
    const existingMembership = await pool.query(
      `SELECT * FROM user_group_memberships 
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    if (existingMembership.rows.length > 0) {
      logger.warn(`User ${userId} already in group ${groupId}`);
      return res.status(400).json({ error: "User already in group" });
    }

    // Add user to group
    await pool.query(
      `INSERT INTO user_group_memberships (group_id, user_id, added_by, added_at)
       VALUES ($1, $2, $3, NOW())`,
      [groupId, userId, req.user.user_id]
    );

    logger.route(`=== ADD USER TO GROUP COMPLETED ===`);

    res.json({ message: "User added to group successfully" });
  } catch (err) {
    logger.error("Error adding user to group", {
      error: err.message,
      group_id: groupId,
      user_id: userId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Remove user from group
router.delete("/:groupId/users/:userId", auth, isAdmin, async (req, res) => {
  const logger = req.logger;
  const { groupId, userId } = req.params;

  try {
    logger.route(
      `=== REMOVE USER FROM GROUP STARTED: ${userId} <- ${groupId} ===`
    );

    await pool.query(
      `DELETE FROM user_group_memberships 
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    logger.route(`=== REMOVE USER FROM GROUP COMPLETED ===`);

    res.json({ message: "User removed from group successfully" });
  } catch (err) {
    logger.error("Error removing user from group", {
      error: err.message,
      group_id: groupId,
      user_id: userId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Get group members
router.get("/:groupId/users", auth, async (req, res) => {
  const logger = req.logger;
  const { groupId } = req.params;

  try {
    logger.route(`=== GET GROUP MEMBERS STARTED: ${groupId} ===`);

    const result = await pool.query(
      `SELECT 
        u.user_id, u.emp_id, u.name, u.email, u.role, u.department,
        u.status, u.profile_image,
        ugm.added_at
       FROM user_group_memberships ugm
       JOIN usermaster u ON ugm.user_id = u.user_id
       WHERE ugm.group_id = $1
       ORDER BY u.name`,
      [groupId]
    );

    logger.route(`=== GET GROUP MEMBERS COMPLETED: ${groupId} ===`);
    logger.info(`Returned ${result.rows.length} members for group ${groupId}`);

    res.json(result.rows);
  } catch (err) {
    logger.error("Error fetching group members", {
      error: err.message,
      group_id: groupId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

// Get user's groups
router.get("/user/:userId/groups", auth, async (req, res) => {
  const logger = req.logger;
  const { userId } = req.params;

  try {
    logger.route(`=== GET USER'S GROUPS STARTED: ${userId} ===`);

    const result = await pool.query(
      `SELECT 
        g.group_id, g.group_name, g.description, g.color,
        g.created_at
       FROM user_group_memberships ugm
       JOIN user_groups g ON ugm.group_id = g.group_id
       WHERE ugm.user_id = $1 AND g.is_active = true
       ORDER BY g.group_name`,
      [userId]
    );

    logger.route(`=== GET USER'S GROUPS COMPLETED: ${userId} ===`);

    res.json(result.rows);
  } catch (err) {
    logger.error("Error fetching user's groups", {
      error: err.message,
      user_id: userId,
      stack: err.stack,
    });
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
