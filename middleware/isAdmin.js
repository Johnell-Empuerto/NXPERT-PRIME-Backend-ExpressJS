const isAdmin = (req, res, next) => {
  console.log("\n=== isAdmin MIDDLEWARE DEBUG ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`URL: ${req.url}`);
  console.log(`Method: ${req.method}`);

  try {
    console.log(`req.user exists: ${!!req.user}`);

    if (!req.user) {
      console.log("FAIL: No req.user object");
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
        debug: { hasUser: false },
      });
    }

    console.log("req.user object:", req.user);
    console.log(`User: ${req.user.name} (${req.user.emp_id})`);
    console.log(`is_admin value: ${req.user.is_admin}`);
    console.log(`is_admin type: ${typeof req.user.is_admin}`);

    // Test all possible comparisons
    const comparisons = {
      strictTrue: req.user.is_admin === true,
      looseTrue: req.user.is_admin == true,
      strictFalse: req.user.is_admin === false,
      looseFalse: req.user.is_admin == false,
      stringTrue: req.user.is_admin === "true",
      stringFalse: req.user.is_admin === "false",
      numberOne: req.user.is_admin === 1,
      numberZero: req.user.is_admin === 0,
      booleanTrue: Boolean(req.user.is_admin) === true,
      booleanFalse: Boolean(req.user.is_admin) === false,
    };

    console.log("Comparisons:", comparisons);

    // Check multiple possible true values
    const isAdminUser =
      req.user.is_admin === true ||
      req.user.is_admin === "true" ||
      req.user.is_admin === 1 ||
      req.user.is_admin === "1" ||
      Boolean(req.user.is_admin) === true;

    console.log(`isAdminUser calculation result: ${isAdminUser}`);

    if (!isAdminUser) {
      console.log("FAIL: User is not admin according to checks");
      return res.status(403).json({
        success: false,
        message: "Admin access only",
        debug: {
          user_id: req.user.user_id,
          emp_id: req.user.emp_id,
          name: req.user.name,
          is_admin_value: req.user.is_admin,
          is_admin_type: typeof req.user.is_admin,
          comparisons: comparisons,
          isAdminUser_result: isAdminUser,
        },
      });
    }

    console.log("SUCCESS: User is admin, allowing access");
    console.log("=== END isAdmin DEBUG ===\n");
    next();
  } catch (err) {
    console.error("Admin check error:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({
      success: false,
      message: "Server error during admin check",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

module.exports = isAdmin;
