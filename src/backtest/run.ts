import fs from "fs";
import path from "path";
import { runBacktest } from "./engine.js";
import type { BacktestConfig, BacktestResult } from "../types.js";
import { loadSeries } from "../data/index.js";

const RESULTS_PATH = path.join(process.cwd(), "data", "results.json");

export async function runWithConfig(config: BacktestConfig): Promise<BacktestResult> {
  const series = await loadSeries(config);
  return runBacktest(config, series);
}

export async function loadOrRun(config: BacktestConfig, force = false): Promise<BacktestResult> {
  if (!force && fs.existsSync(RESULTS_PATH)) {
    const raw = fs.readFileSync(RESULTS_PATH, "utf8");
    return JSON.parse(raw) as BacktestResult;
  }

  const result = await runWithConfig(config);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2));
  return result;
}

export function resultsPath(): string {
  return RESULTS_PATH;
}
