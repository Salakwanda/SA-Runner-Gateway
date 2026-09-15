const express = require("express");
const path = require("path");
const crypto = require("crypto");
const app = express();
const db = require("./database/db");

const hashPassword = (
  password,
  salt = crypto.randomBytes(16).toString("hex"),
) => {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash) return true;
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) return false;
  const actualHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(actualHash, "hex"),
    Buffer.from(expectedHash, "hex"),
  );
};

app.use(express.json()); // parse JSON bodies
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Views and static
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

const getCookie = (req, name) => {
  const cookies = (req.headers.cookie || "").split(";");
  const cookie = cookies.find((item) => item.trim().startsWith(`${name}=`));
  return cookie
    ? decodeURIComponent(cookie.trim().slice(name.length + 1))
    : null;
};

const createUserToken = (user) =>
  Buffer.from(`${user.id}:${user.role}`).toString("base64url");

const getCurrentUser = (req) => {
  const cookie = getCookie(req, "srg_user");
  if (!cookie) return null;
  const [token, signature] = cookie.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", process.env.SRG_SECRET || "local-runner-gateway")
    .update(token || "")
    .digest("base64url");
  if (!token || signature !== expectedSignature) return null;
  const decoded = Buffer.from(token, "base64url").toString("utf8").split(":");
  if (decoded.length !== 2) return null;
  return db
    .prepare(
      "SELECT id, full_name, email, role FROM users WHERE id = ? AND role = ?",
    )
    .get(decoded[0], decoded[1]);
};

app.use((req, res, next) => {
  req.user = getCurrentUser(req);
  res.locals.currentUser = req.user;
  next();
});

const requireUser = (req, res, next) => {
  if (!res.locals.currentUser) return res.redirect("/login");
  next();
};

const requireRole = (role) => (req, res, next) => {
  if (!res.locals.currentUser) return res.redirect(`/login?role=${role}`);
  if (res.locals.currentUser.role !== role) return res.redirect("/");
  next();
};

const requireAdminApi = (req, res, next) => {
  if (!req.user || req.user.role !== "ADMIN") {
    return res
      .status(403)
      .json({ status: "error", message: "Admin access required." });
  }
  next();
};

const errandRoutes = require("./routes/errandRoutes");
app.use("/", errandRoutes); // mount API routes as defined in the router

app.get("/login", (req, res) => {
  if (res.locals.currentUser) return res.redirect("/");
  res.render("login", {
    error: null,
    selectedRole: req.query.role || "CLIENT",
  });
});

app.get("/register", (req, res) => {
  if (res.locals.currentUser) return res.redirect("/");
  res.render("register", {
    error: null,
    selectedRole: req.query.role || "CLIENT",
    formData: {},
  });
});

app.post("/register", (req, res) => {
  const {
    full_name: fullName,
    email,
    phone,
    password,
    role,
    city,
    id_number: idNumber,
  } = req.body;
  const formData = { fullName, email, phone, city, idNumber };
  const selectedRole = role || "CLIENT";
  const renderError = (error, status = 400) =>
    res.status(status).render("register", { error, selectedRole, formData });
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();

  if (
    !fullName ||
    !normalizedEmail ||
    !phone ||
    !password ||
    !["CLIENT", "RUNNER"].includes(selectedRole)
  )
    return renderError("Please complete all required fields.");
  if (String(password).length < 8)
    return renderError("Your password must be at least 8 characters.");
  if (selectedRole === "RUNNER" && (!city || !idNumber))
    return renderError("Runners must provide their city and ID number.");
  if (
    db
      .prepare("SELECT 1 FROM users WHERE lower(email) = ?")
      .get(normalizedEmail)
  )
    return renderError(
      "An account with that email already exists. Try logging in.",
      409,
    );

  const userId = `USR-${selectedRole}-${Math.floor(1000 + Math.random() * 9000)}`;
  try {
    db.transaction(() => {
      db.prepare(
        "INSERT INTO users (id, full_name, email, phone, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        userId,
        String(fullName).trim(),
        normalizedEmail,
        String(phone).trim(),
        selectedRole,
        hashPassword(String(password)),
      );
      if (selectedRole === "RUNNER")
        db.prepare(
          "INSERT INTO runner_profiles (user_id, city, id_number, is_verified) VALUES (?, ?, ?, 0)",
        ).run(userId, String(city).trim(), String(idNumber).trim());
    })();
  } catch (error) {
    return renderError(
      "We could not create the account. Please try again.",
      500,
    );
  }
  res.redirect(`/login?role=${selectedRole}&created=1`);
});

app.post("/login", (req, res) => {
  const { email, password, role } = req.body;
  const user = db
    .prepare(
      "SELECT id, full_name, email, role, password_hash FROM users WHERE lower(email) = lower(?) AND role = ?",
    )
    .get(String(email || "").trim(), role);

  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    return res.status(401).render("login", {
      error: "We could not find that email for the selected role.",
      selectedRole: role || "CLIENT",
    });
  }

  const token = createUserToken(user);
  const signature = crypto
    .createHmac("sha256", process.env.SRG_SECRET || "local-runner-gateway")
    .update(token)
    .digest("base64url");
  res.setHeader(
    "Set-Cookie",
    `srg_user=${encodeURIComponent(`${token}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax`,
  );
  res.redirect(user.role === "RUNNER" ? "/runner" : "/");
});

app.post("/logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    "srg_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  );
  res.redirect("/login");
});

app.get("/", (req, res) => {
  try {
    const totalUsers =
      db.prepare("SELECT COUNT(*) as count FROM users").get().count || 0;
    const totalErrands =
      db.prepare("SELECT COUNT(*) as count FROM errands").get().count || 0;
    const verifiedRunners =
      db
        .prepare(
          "SELECT COUNT(*) as count FROM runner_profiles WHERE is_verified = 1",
        )
        .get().count || 0;

    res.render("index", { totalUsers, totalErrands, verifiedRunners });
  } catch (error) {
    res.status(500).send(`<h3>❌ Database Error:</h3> <p>${error.message}</p>`);
  }
});

app.get("/create", requireRole("CLIENT"), (req, res) => res.render("create"));
app.get("/runner", requireRole("RUNNER"), (req, res) => res.render("runner"));
app.get("/track", (req, res) => res.render("track"));
app.get("/admin", requireRole("ADMIN"), (req, res) => res.render("admin"));

app.locals.requireAdminApi = requireAdminApi;

module.exports = app;
