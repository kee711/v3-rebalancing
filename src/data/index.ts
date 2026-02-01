import type { BacktestConfig, MarketPoint } from "../types.js";
import { loadCsvSeries } from "./csv.js";
import { generateSampleSeries } from "./sample.js";
import { loadTheGraphSeries } from "./thegraph.js";

export async function loadSeries(config: BacktestConfig): Promise<MarketPoint[]> {
  if (config.dataSource === "csv") {
    return loadCsvSeries();
  }

  if (config.dataSource === "thegraph") {
    return loadTheGraphSeries(config);
  }

  return generateSampleSeries(config);
}
