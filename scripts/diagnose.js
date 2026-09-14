const path = require("path");
const fs = require("fs");

console.log("Project diagnose script");

// Check Node version
console.log("Node version:", process.version);

// Attempt to require DB and list tables
try {
  const db = require(path.join(__dirname, "..", "database", "db.js"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  console.log(
    "SQLite tables:",
    tables.map((t) => t.name),
  );
} catch (e) {
  console.error("Error requiring database/db.js:", e && e.stack ? e.stack : e);
}

// Attempt to require app (should not start server)
try {
  const app = require(path.join(__dirname, "..", "app.js"));
  console.log("app.js required successfully (Express app loaded)");
} catch (e) {
  console.error("Error requiring app.js:", e && e.stack ? e.stack : e);
}

console.log("Diagnostics complete.");
