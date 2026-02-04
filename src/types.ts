import type { PoolType, RebalanceParams } from "./strategies.js";

export interface BacktestConfig {
  poolType: PoolType;
  symbol: string;
  timeStepMinutes: number;
  lookbackDays: number;
  initialCapitalUsd: number;
  feesApr: number;
  emissionsApr: number;
  liquidityUsd: number;
  gasUsd: number;
  dataSource: "sample" | "csv" | "thegraph";
  sample: {
    startPrice: number;
    volDaily: number;
    driftDaily: number;
    seed: number;
  };
  theGraph?: {
    apiKey: string;
    poolAddress: string;
    subgraphId?: string;
    startTimestamp?: number;
    endTimestamp?: number;
  };
  windows: {
    volDays: number;
    twapShortHours: number;
    twapLongHours: number;
  };
  rebalanceParams: RebalanceParams;
}

export interface MarketPoint {
  ts: number;
  price: number;
  feesApr: number;
  emissionsApr: number;
  liquidityUsd: number;
  gasUsd: number;
  // New: volume-based fee calculation
  volumeUsd: number; // Trading volume in this time step
  feeTier: number; // Fee tier (e.g., 0.003 for 0.3%)
}

export interface BacktestSummary {
  startValueUsd: number;
  endValueUsd: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  feesUsd: number;
  emissionsUsd: number;
  gasUsd: number;
  mevUsd: number; // MEV/sandwich attack costs
  rebalances: number;
  maxDrawdownPct: number;
}

export interface BacktestAction {
  ts: number;
  strategy: string;
  reason: string;
  actions: string[];
  gasUsd: number;
}

export interface BacktestResult {
  meta: {
    generatedAt: number;
    symbol: string;
    poolType: PoolType;
    points: number;
  };
  summary: BacktestSummary;
  equityCurve: { ts: number; valueUsd: number; price: number }[];
  actions: BacktestAction[];
  lastSnapshot: {
    ts: number;
    price: number;
    twapShort: number;
    twapLong: number;
    vol: number;
  };
}

export interface BacktestContext {
  config: BacktestConfig;
  series: MarketPoint[];
}
