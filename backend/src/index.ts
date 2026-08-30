import express from "express";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`ARA backend listening on http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/api/health`);
});
