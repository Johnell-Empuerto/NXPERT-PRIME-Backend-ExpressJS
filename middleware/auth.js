const jwt = require("jsonwebtoken");

const auth = (req, res, next) => {
  console.log("\n=== AUTH MIDDLEWARE DEBUG ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`URL: ${req.url}`);
  console.log(`Method: ${req.method}`);

  const authHeader = req.headers.authorization;
  console.log(`Authorization header: ${authHeader || "None"}`);

  if (!authHeader) {
    console.log("FAIL: No authorization header");
    return res.status(401).json({
      success: false,
      message: "No token provided",
    });
  }

  const token = authHeader.split(" ")[1]; // Bearer TOKEN
  console.log(
    `Token extracted (first 20 chars): ${
      token ? token.substring(0, 20) + "..." : "None"
    }`
  );

  try {
    console.log("Verifying JWT token...");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("JWT Verification SUCCESS");
    console.log("Decoded JWT payload:", decoded);
    console.log(`is_admin in decoded token: ${decoded.is_admin}`);
    console.log(`Type of is_admin: ${typeof decoded.is_admin}`);

    req.user = decoded; // { user_id, emp_id, role, is_admin, name }
    console.log(`User set in req.user: ${req.user.name} (${req.user.emp_id})`);

    next();
  } catch (err) {
    console.log("JWT Verification FAILED:", err.message);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

module.exports = auth;
