const express = require("express");
const router = express.Router();
const db = require("../database/db");
const requireAdminApi = (req, res, next) => {
  if (!req.user || req.user.role !== "ADMIN") {
    return res
      .status(403)
      .json({ status: "error", message: "Admin access required." });
  }
  next();
};

// Helper generator for tracking IDs
const generateTrackingId = () =>
  `RUN-ZA-${Math.floor(100000 + Math.random() * 900000)}`;

const canChat = (user, errand) => {
  if (user.role === "CLIENT") return user.id === errand.client_id;
  if (user.role !== "RUNNER") return false;

  const runner = db
    .prepare("SELECT is_verified FROM runner_profiles WHERE user_id = ?")
    .get(user.id);

  if (!runner || runner.is_verified !== 1) return false;

  if (errand.runner_id) return user.id === errand.runner_id;
  return errand.status === "PENDING";
};

// Get all unverified runners
router.get("/api/admin/users", requireAdminApi, (req, res) => {
  const clients = db
    .prepare(
      "SELECT id, full_name, email, phone, created_at FROM users WHERE role = 'CLIENT' ORDER BY created_at DESC",
    )
    .all();
  const runners = db
    .prepare(
      `
      SELECT users.id, users.full_name, users.email, users.phone, users.created_at,
             runner_profiles.city, runner_profiles.id_number, runner_profiles.is_verified
      FROM users
      JOIN runner_profiles ON runner_profiles.user_id = users.id
      WHERE users.role = 'RUNNER'
      ORDER BY users.created_at DESC
    `,
    )
    .all();
  res.json({ status: "success", data: { clients, runners } });
});

router.get("/api/admin/unverified-runners", requireAdminApi, (req, res) => {
  const unverifiedRunners = db
    .prepare(
      `
    SELECT users.id, users.full_name, users.email, users.phone, runner_profiles.city, runner_profiles.id_number, runner_profiles.is_verified
    FROM runner_profiles
    JOIN users ON runner_profiles.user_id = users.id
    WHERE runner_profiles.is_verified = 0
  `,
    )
    .all();

  res.json({ status: "success", data: unverifiedRunners });
});

// Verify a runner (Admin Toggle Button)
router.post("/api/admin/verify-runner/:userId", requireAdminApi, (req, res) => {
  const { userId } = req.params;

  const stmt = db.prepare(`
    UPDATE runner_profiles
    SET is_verified = 1
    WHERE user_id = ?
  `);

  const result = stmt.run(userId);

  if (result.changes > 0) {
    res.json({
      status: "success",
      message: `Runner ${userId} verified successfully.`,
    });
  } else {
    res.status(404).json({ status: "error", message: "Runner not found." });
  }
});

router.post(
  "/api/admin/runner/:userId/verification",
  requireAdminApi,
  (req, res) => {
    const isVerified = Number(req.body.is_verified) === 1 ? 1 : 0;
    const result = db
      .prepare("UPDATE runner_profiles SET is_verified = ? WHERE user_id = ?")
      .run(isVerified, req.params.userId);
    if (!result.changes)
      return res
        .status(404)
        .json({ status: "error", message: "Runner not found." });
    res.json({ status: "success", is_verified: isVerified });
  },
);

// Create a new errand request
router.post("/api/errands", (req, res) => {
  if (!req.user || req.user.role !== "CLIENT") {
    return res.status(401).json({
      status: "error",
      message: "You must be logged in as a client to request an errand.",
    });
  }

  const {
    pickup_city,
    dropoff_city,
    delivery_method,
    item_description,
    reward_amount,
  } = req.body;
  const trackingId = generateTrackingId();

  const stmt = db.prepare(`
    INSERT INTO errands (id, client_id, pickup_city, dropoff_city, delivery_method, item_description, reward_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `);

  stmt.run(
    trackingId,
    req.user.id,
    pickup_city,
    dropoff_city,
    delivery_method,
    item_description,
    reward_amount,
  );

  res.status(201).json({
    status: "success",
    message: "Errand requested successfully",
    tracking_id: trackingId,
  });
});

// Client Order History & Status
router.get("/api/client/:clientId/errands", (req, res) => {
  const { clientId } = req.params;

  const errands = db
    .prepare(
      `
    SELECT errands.*, client.full_name AS client_name,
           runner.full_name AS runner_name
    FROM errands
    JOIN users AS client ON client.id = errands.client_id
    LEFT JOIN users AS runner ON runner.id = errands.runner_id
    WHERE errands.client_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(clientId);

  res.json({ status: "success", data: errands });
});

router.get("/api/client/errands", (req, res) => {
  if (!req.user || req.user.role !== "CLIENT") {
    return res
      .status(401)
      .json({ status: "error", message: "Client login required." });
  }

  const errands = db
    .prepare(
      `
         SELECT errands.*, client.full_name AS client_name,
           runner.full_name AS runner_name
         FROM errands
         JOIN users AS client ON client.id = errands.client_id
         LEFT JOIN users AS runner ON runner.id = errands.runner_id
         WHERE errands.client_id = ? AND errands.status IN ('PENDING', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED')
        ORDER BY created_at DESC
      `,
    )
    .all(req.user.id);

  res.json({ status: "success", role: req.user.role, data: errands });
});

router.get("/api/my/errands", (req, res) => {
  if (!req.user || !["CLIENT", "RUNNER"].includes(req.user.role)) {
    return res.status(401).json({
      status: "error",
      message: "Client or runner login required.",
    });
  }

  const filter =
    req.user.role === "CLIENT"
      ? "errands.client_id = ?"
      : "errands.runner_id = ?";
  const errands = db
    .prepare(
      `SELECT errands.*, client.full_name AS client_name,
              runner.full_name AS runner_name
       FROM errands
       JOIN users AS client ON client.id = errands.client_id
       LEFT JOIN users AS runner ON runner.id = errands.runner_id
       WHERE ${filter}
       ORDER BY errands.created_at DESC`,
    )
    .all(req.user.id);

  res.json({ status: "success", data: errands });
});

// Runner Job Feed (Shows all open requests to all verified runners)
router.get("/api/runner/feed", (req, res) => {
  if (!req.user || req.user.role !== "RUNNER") {
    return res
      .status(401)
      .json({ status: "error", message: "Runner login required." });
  }

  const runner = db
    .prepare(
      `
    SELECT city, is_verified FROM runner_profiles WHERE user_id = ?
  `,
    )
    .get(req.user.id);

  if (!runner) {
    return res
      .status(404)
      .json({ status: "error", message: "Runner profile not found." });
  }

  if (runner.is_verified === 0) {
    return res.status(403).json({
      status: "gated",
      message:
        "Account pending admin verification. You cannot view available errands yet.",
    });
  }

  const availableErrands = db
    .prepare(
      `
    SELECT errands.*, client.full_name AS client_name,
           runner.full_name AS runner_name,
           CASE WHEN errands.runner_id = ? THEN 1 ELSE 0 END AS assigned_to_me
    FROM errands
    JOIN users AS client ON client.id = errands.client_id
    LEFT JOIN users AS runner ON runner.id = errands.runner_id
    WHERE (errands.status = 'PENDING' AND errands.runner_id IS NULL)
       OR errands.runner_id = ?
    ORDER BY CASE WHEN errands.runner_id = ? THEN 0 ELSE 1 END, errands.created_at DESC
  `,
    )
    .all(req.user.id, req.user.id, req.user.id);

  res.json({
    status: "success",
    runner_city: runner.city,
    data: availableErrands,
  });
});

// Keep the old URL from silently using an arbitrary runner identity.
router.get("/api/runner/:runnerId/feed", (req, res) => {
  res.redirect(307, "/api/runner/feed");
});

// Runner Accepts an Errand
router.post("/api/errands/:id/accept", (req, res) => {
  const { id } = req.params;
  if (!req.user || req.user.role !== "RUNNER") {
    return res
      .status(401)
      .json({ status: "error", message: "Runner login required." });
  }
  const runnerId = req.user.id;

  const runner = db
    .prepare("SELECT is_verified FROM runner_profiles WHERE user_id = ?")
    .get(runnerId);

  if (!runner || runner.is_verified === 0) {
    return res.status(403).json({
      status: "error",
      message: "Unverified runners cannot accept errands.",
    });
  }

  const stmt = db.prepare(`
    UPDATE errands
    SET runner_id = ?, status = 'ACCEPTED'
    WHERE id = ? AND status = 'PENDING'
  `);

  const result = stmt.run(runnerId, id);

  if (result.changes > 0) {
    const accepted = db
      .prepare(
        `SELECT errands.*, client.full_name AS client_name,
                runner.full_name AS runner_name
         FROM errands
         JOIN users AS client ON client.id = errands.client_id
         LEFT JOIN users AS runner ON runner.id = errands.runner_id
         WHERE errands.id = ?`,
      )
      .get(id);
    res.json({
      status: "success",
      message: "Errand accepted successfully!",
      data: accepted,
    });
  } else {
    res.status(400).json({
      status: "error",
      message: "Errand is no longer available or does not exist.",
    });
  }
});

router.put("/api/errands/:id", (req, res) => {
  if (!req.user || req.user.role !== "CLIENT") {
    return res
      .status(401)
      .json({ status: "error", message: "Client login required." });
  }

  const errand = db
    .prepare("SELECT * FROM errands WHERE id = ?")
    .get(req.params.id);

  if (!errand) {
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  }

  if (errand.client_id !== req.user.id) {
    return res.status(403).json({
      status: "error",
      message: "You can only edit your own errands.",
    });
  }

  if (errand.status !== "PENDING") {
    return res.status(400).json({
      status: "error",
      message: "This request can no longer be edited after acceptance.",
    });
  }

  const allowedFields = [
    "pickup_city",
    "dropoff_city",
    "delivery_method",
    "item_description",
    "reward_amount",
  ];

  const updates = {};
  allowedFields.forEach((field) => {
    if (field in req.body) {
      updates[field] = req.body[field];
    }
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      status: "error",
      message: "No editable fields were supplied.",
    });
  }

  const setClauses = Object.keys(updates)
    .map((field) => `${field} = ?`)
    .join(", ");
  const values = Object.values(updates);

  const result = db
    .prepare(
      `UPDATE errands SET ${setClauses} WHERE id = ? AND client_id = ? AND status = 'PENDING'`,
    )
    .run(...values, req.params.id, req.user.id);

  if (result.changes === 0) {
    return res.status(400).json({
      status: "error",
      message: "Unable to update this request right now.",
    });
  }

  const updated = db
    .prepare("SELECT * FROM errands WHERE id = ?")
    .get(req.params.id);

  res.json({ status: "success", message: "Request updated.", data: updated });
});

router.post("/api/errands/:id/cancel", (req, res) => {
  if (!req.user || req.user.role !== "CLIENT") {
    return res
      .status(401)
      .json({ status: "error", message: "Client login required." });
  }

  const errand = db
    .prepare("SELECT client_id, status FROM errands WHERE id = ?")
    .get(req.params.id);

  if (!errand) {
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  }

  if (errand.client_id !== req.user.id) {
    return res.status(403).json({
      status: "error",
      message: "You can only cancel your own errands.",
    });
  }

  if (!["PENDING", "ACCEPTED"].includes(errand.status)) {
    return res.status(400).json({
      status: "error",
      message: "This request can no longer be cancelled.",
    });
  }

  const result = db
    .prepare(
      "UPDATE errands SET status = 'CANCELLED' WHERE id = ? AND client_id = ? AND status IN ('PENDING', 'ACCEPTED')",
    )
    .run(req.params.id, req.user.id);

  if (result.changes === 0) {
    return res.status(400).json({
      status: "error",
      message: "This request could not be cancelled.",
    });
  }

  res.json({ status: "success", message: "Request cancelled." });
});

router.post("/api/errands/:id/status", (req, res) => {
  if (!req.user || req.user.role !== "RUNNER") {
    return res
      .status(401)
      .json({ status: "error", message: "Runner login required." });
  }

  const { status } = req.body;
  const allowedStatuses = ["ACCEPTED", "IN_TRANSIT", "COMPLETED", "CANCELLED"];

  const errand = db
    .prepare("SELECT * FROM errands WHERE id = ?")
    .get(req.params.id);

  if (!errand) {
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  }

  const runner = db
    .prepare("SELECT is_verified FROM runner_profiles WHERE user_id = ?")
    .get(req.user.id);
  if (!runner || runner.is_verified !== 1) {
    return res.status(403).json({
      status: "error",
      message: "Only verified runners can manage errands.",
    });
  }

  if (errand.runner_id && errand.runner_id !== req.user.id) {
    return res.status(403).json({
      status: "error",
      message: "This errand is already assigned to another runner.",
    });
  }

  if (
    status === "PENDING" &&
    errand.runner_id === req.user.id &&
    ["ACCEPTED", "IN_TRANSIT"].includes(errand.status)
  ) {
    db.prepare(
      "UPDATE errands SET runner_id = NULL, status = 'PENDING' WHERE id = ? AND runner_id = ?",
    ).run(req.params.id, req.user.id);

    return res.json({
      status: "success",
      message: "Request reopened for other runners.",
    });
  }

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      status: "error",
      message: "Invalid status update.",
    });
  }

  if (errand.status !== "ACCEPTED" && errand.status !== "IN_TRANSIT") {
    return res.status(400).json({
      status: "error",
      message:
        "Status updates are only allowed after a runner accepts the errand.",
    });
  }

  const result = db
    .prepare("UPDATE errands SET status = ? WHERE id = ? AND runner_id = ?")
    .run(status, req.params.id, req.user.id);

  if (result.changes === 0) {
    return res.status(400).json({
      status: "error",
      message: "Could not update the status.",
    });
  }

  res.json({ status: "success", message: "Status updated." });
});

// Get a single errand by id
router.get("/api/errands/:id", (req, res) => {
  const { id } = req.params;
  const errand = db
    .prepare(
      `SELECT errands.*, client.full_name AS client_name,
              runner.full_name AS runner_name
       FROM errands
       JOIN users AS client ON client.id = errands.client_id
       LEFT JOIN users AS runner ON runner.id = errands.runner_id
       WHERE errands.id = ?`,
    )
    .get(id);
  if (!errand)
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  res.json({ status: "success", data: errand });
});

// ==========================================
// 4. CHAT MESSAGES ROUTES
// ==========================================

// Get chat history for an errand
router.get("/api/errands/:errandId/messages", (req, res) => {
  const { errandId } = req.params;
  const errand = db
    .prepare(
      "SELECT client_id, runner_id, pickup_city, status FROM errands WHERE id = ?",
    )
    .get(errandId);
  if (!errand)
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  if (!req.user || !canChat(req.user, errand)) {
    return res
      .status(403)
      .json({ status: "error", message: "You cannot access this chat." });
  }

  const messages = db
    .prepare(
      `
    SELECT messages.id, messages.sender_id, users.full_name as sender_name, messages.message_text, messages.sent_at
    FROM messages
    JOIN users ON messages.sender_id = users.id
    WHERE errand_id = ?
    ORDER BY sent_at ASC
  `,
    )
    .all(errandId);

  res.json({ status: "success", data: messages });
});

// Send a chat message
router.post("/api/errands/:errandId/messages", (req, res) => {
  const { errandId } = req.params;
  const { message_text: messageText } = req.body;
  const errand = db
    .prepare(
      "SELECT client_id, runner_id, pickup_city, status FROM errands WHERE id = ?",
    )
    .get(errandId);
  if (!errand)
    return res
      .status(404)
      .json({ status: "error", message: "Errand not found." });
  if (!req.user || !canChat(req.user, errand)) {
    return res.status(403).json({
      status: "error",
      message: "You cannot send messages in this chat.",
    });
  }
  if (!String(messageText || "").trim()) {
    return res
      .status(400)
      .json({ status: "error", message: "Message cannot be empty." });
  }

  const stmt = db.prepare(`
    INSERT INTO messages (errand_id, sender_id, message_text)
    VALUES (?, ?, ?)
  `);

  stmt.run(errandId, req.user.id, String(messageText).trim());

  res
    .status(201)
    .json({ status: "success", message: "Message sent successfully." });
});

module.exports = router;
