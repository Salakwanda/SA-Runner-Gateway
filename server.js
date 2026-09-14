const app = require("./app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
