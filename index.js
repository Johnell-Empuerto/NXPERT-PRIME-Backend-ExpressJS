const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const path = require("path");

const corsOptions = {
  origin: [process.env.FRONTEND_ORIGIN, "http://localhost:5173"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

app.get("/Backend", (req, res) => {
  res.send("API is running...");
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

//make folder images accessable through browser
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Parse JSON bodies
app.use(express.json());

// Import your login route
const loginRouter = require("./routes/login/getlogin");
const forgotPasswordRouter = require("./routes/login/forgotPassword");
const getUsersLoginRouter = require("./routes/profile/getusers");
const uploadProfileRouter = require("./routes/profile/uploadprofile");
const getAlluserMasterRouter = require("./routes/usersmaster/getAlluserMaster");
const adduserMasterRouter = require("./routes/usersmaster/addUserMaster");
const editUserMasterRouter = require("./routes/usersmaster/editUserMaster");
const userPermissionsRouter = require("./routes/usersmaster/userPermissions");
const testSmtpRouter = require("./routes/smtp/testSmtp");
const settingsRouter = require("./routes/smtp/settings");
const ProductionPlanningRouter = require("./routes/productionplanning/productionplanning");
const checksheetRouter = require("./routes/cheeksheet/checksheet");
const userGroupsRoutes = require("./routes/usersmaster/userGroups");

//api for login
app.use("/Backend/api/login", loginRouter);

//getUserLogin
app.use("/Backend/api/users", getUsersLoginRouter);

//get userprofile
app.use("/Backend/api/usersprofile", uploadProfileRouter);

//for uploading image
app.use("/Backend/uploads", express.static("uploads"));

//get all user master
app.use("/Backend/api/getallusermaster", getAlluserMasterRouter);

//insert to user master
app.use("/Backend/api/addtousermaster", adduserMasterRouter);

//edit UserMaster
app.use("/Backend/api/editusermaster", editUserMasterRouter);

//user permissions
app.use("/Backend/api/userpermissions", userPermissionsRouter);

//user groups
app.use("/Backend/api/usergroups", userGroupsRoutes);

//smtp
app.use("/Backend/api/test-smtp", testSmtpRouter);
app.use("/Backend/api/settings", settingsRouter);
//forget password
app.use("/Backend/api/forgot-password", forgotPasswordRouter);

//production planning
app.use("/Backend/api/productionplanning", ProductionPlanningRouter);

//checksheet
app.use("/Backend/api/checksheet", checksheetRouter);

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on no ${PORT}`);
});
