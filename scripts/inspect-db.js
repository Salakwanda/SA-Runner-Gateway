const Database = require("better-sqlite3");
const path = require("path");
const dbPath = path.join(__dirname, "..", "database", "errands.db");
console.log("Inspecting DB at", dbPath);
const fs = require("fs");
if (!fs.existsSync(dbPath)) {
  console.log("Database file not found.");
  process.exit(0);
}
const db = new Database(dbPath, { readonly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all();
console.log(
  "Tables:",
  tables.map((t) => t.name),
);
const dumpTable = (name) => {
  try {
    const rows = db.prepare(`SELECT * FROM ${name} LIMIT 100`).all();
    console.log(`\n${name} (${rows.length} rows):`);
    console.table(rows);
  } catch (e) {
    console.error(`Error reading table ${name}:`, e.message);
  }
};
["users", "runner_profiles", "errands", "messages"].forEach(dumpTable);
