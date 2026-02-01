import fs from "fs";
import path from "path";
import { defaultParams, type RebalanceParams } from "./strategies.js";
import type { BacktestConfig } from "./types.js";

const DEFAULT_PATH = path.join(process.cwd(), "config", "backtest.json");

export function loadConfig(): BacktestConfig {
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_PATH;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<BacktestConfig>;

  const rebalanceParams: RebalanceParams = {
    ...defaultParams,
    ...(raw.rebalanceParams ?? {})
  };

  const theGraphConfig = raw.theGraph
    ? {
        apiKey: raw.theGraph.apiKey ?? process.env.THEGRAPH_API_KEY ?? "",
        poolAddress: raw.theGraph.poolAddress ?? "",
        subgraphId: raw.theGraph.subgraphId ?? process.env.THEGRAPH_SUBGRAPH_ID,
        startTimestamp: raw.theGraph.startTimestamp ?? undefined,
        endTimestamp: raw.theGraph.endTimestamp ?? undefined
      }
    : undefined;

  return {
    poolType: raw.poolType ?? "cl",
    symbol: raw.symbol ?? "WETH/USDC",
    timeStepMinutes: raw.timeStepMinutes ?? 60,
    lookbackDays: raw.lookbackDays ?? 30,
    initialCapitalUsd: raw.initialCapitalUsd ?? 10000,
    feesApr: raw.feesApr ?? 0.2,
    emissionsApr: raw.emissionsApr ?? 0.2,
    liquidityUsd: raw.liquidityUsd ?? 10000000,
    gasUsd: raw.gasUsd ?? 0.6,
    dataSource: raw.dataSource ?? "sample",
    sample: {
      startPrice: raw.sample?.startPrice ?? 1800,
      volDaily: raw.sample?.volDaily ?? 0.04,
      driftDaily: raw.sample?.driftDaily ?? 0,
      seed: raw.sample?.seed ?? 42
    },
    theGraph: theGraphConfig,
    windows: {
      volDays: raw.windows?.volDays ?? 7,
      twapShortHours: raw.windows?.twapShortHours ?? 6,
      twapLongHours: raw.windows?.twapLongHours ?? 48
    },
    rebalanceParams
  };
}
