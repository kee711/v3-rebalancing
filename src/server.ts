import path from "path";
import express from "express";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { loadOrRun } from "./backtest/run.js";
import type { BacktestResult } from "./types.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3000);
const config = loadConfig();

let cached: BacktestResult | null = null;

async function initCache() {
  cached = await loadOrRun(config, false);
}

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/results", (_req, res) => {
  if (!cached) {
    res.status(503).json({ error: "Backtest not ready yet" });
    return;
  }
  res.json(cached);
});

app.post("/api/run", async (req, res) => {
  try {
    const force = req.query.force === "1";
    cached = await loadOrRun(config, force);
    res.json(cached);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json(config);
});

initCache()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize backtest:", err);
    process.exit(1);
  });
