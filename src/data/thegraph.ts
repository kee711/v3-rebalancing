import type { BacktestConfig, MarketPoint } from "../types.js";

const DEFAULT_SUBGRAPH_ID = "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM";
const GATEWAY_URL = "https://gateway-arbitrum.network.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}";

export interface TheGraphConfig {
  apiKey: string;
  poolAddress: string;
  subgraphId?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

interface PoolHourData {
  periodStartUnix: number;
  open: string;
  high: string;
  low: string;
  close: string;
  liquidity: string;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
  txCount: string;
}

interface SwapData {
  timestamp: string;
  amountUSD: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
}

interface PoolData {
  id: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
  liquidity: string;
  sqrtPrice: string;
  tick: string;
  feeTier: string;
  totalValueLockedUSD: string;
}

function buildUrl(apiKey: string, subgraphId: string = DEFAULT_SUBGRAPH_ID): string {
  return GATEWAY_URL.replace("{API_KEY}", apiKey).replace("{SUBGRAPH_ID}", subgraphId);
}

async function graphqlQuery<T>(config: TheGraphConfig, query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = buildUrl(config.apiKey, config.subgraphId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("No data returned from GraphQL query");
  }

  return json.data;
}

export async function fetchPoolInfo(config: TheGraphConfig): Promise<PoolData | null> {
  const query = `
    query GetPool($id: ID!) {
      pool(id: $id) {
        id
        token0 { symbol decimals }
        token1 { symbol decimals }
        liquidity
        sqrtPrice
        tick
        feeTier
        totalValueLockedUSD
      }
    }
  `;

  const data = await graphqlQuery<{ pool: PoolData | null }>(config, query, {
    id: config.poolAddress.toLowerCase()
  });

  return data.pool;
}

export async function fetchPoolHourData(
  config: TheGraphConfig,
  limit: number = 1000,
  skip: number = 0
): Promise<PoolHourData[]> {
  const startTs = config.startTimestamp ?? Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
  const endTs = config.endTimestamp ?? Math.floor(Date.now() / 1000);

  const query = `
    query GetPoolHourData($poolId: String!, $startTs: Int!, $endTs: Int!, $first: Int!, $skip: Int!) {
      poolHourDatas(
        where: {
          pool: $poolId
          periodStartUnix_gte: $startTs
          periodStartUnix_lte: $endTs
        }
        orderBy: periodStartUnix
        orderDirection: asc
        first: $first
        skip: $skip
      ) {
        periodStartUnix
        open
        high
        low
        close
        liquidity
        volumeUSD
        feesUSD
        tvlUSD
        txCount
      }
    }
  `;

  const data = await graphqlQuery<{ poolHourDatas: PoolHourData[] }>(config, query, {
    poolId: config.poolAddress.toLowerCase(),
    startTs,
    endTs,
    first: limit,
    skip
  });

  return data.poolHourDatas;
}

export async function fetchSwaps(
  config: TheGraphConfig,
  limit: number = 1000,
  skip: number = 0
): Promise<SwapData[]> {
  const startTs = config.startTimestamp ?? Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
  const endTs = config.endTimestamp ?? Math.floor(Date.now() / 1000);

  const query = `
    query GetSwaps($poolId: String!, $startTs: Int!, $endTs: Int!, $first: Int!, $skip: Int!) {
      swaps(
        where: {
          pool: $poolId
          timestamp_gte: $startTs
          timestamp_lte: $endTs
        }
        orderBy: timestamp
        orderDirection: asc
        first: $first
        skip: $skip
      ) {
        timestamp
        amountUSD
        amount0
        amount1
        sqrtPriceX96
      }
    }
  `;

  const data = await graphqlQuery<{ swaps: SwapData[] }>(config, query, {
    poolId: config.poolAddress.toLowerCase(),
    startTs,
    endTs,
    first: limit,
    skip
  });

  return data.swaps;
}

export async function fetchAllPoolHourData(config: TheGraphConfig): Promise<PoolHourData[]> {
  const allData: PoolHourData[] = [];
  let skip = 0;
  const batchSize = 1000;

  while (true) {
    const batch = await fetchPoolHourData(config, batchSize, skip);
    if (batch.length === 0) break;
    allData.push(...batch);
    if (batch.length < batchSize) break;
    skip += batchSize;
  }

  return allData;
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: string, decimals0: number, decimals1: number): number {
  const sqrtPrice = BigInt(sqrtPriceX96);
  const Q96 = BigInt(2) ** BigInt(96);
  const price = Number((sqrtPrice * sqrtPrice * BigInt(10 ** decimals0)) / (Q96 * Q96)) / 10 ** decimals1;
  return price;
}

export async function loadTheGraphSeries(backtestConfig: BacktestConfig): Promise<MarketPoint[]> {
  const theGraphConfig = backtestConfig.theGraph;
  if (!theGraphConfig) {
    throw new Error("theGraph configuration is required when dataSource is 'thegraph'");
  }

  console.log("Fetching pool info...");
  const poolInfo = await fetchPoolInfo(theGraphConfig);
  if (!poolInfo) {
    throw new Error(`Pool not found: ${theGraphConfig.poolAddress}`);
  }

  const feeTier = parseInt(poolInfo.feeTier, 10) / 1_000_000;
  const poolTvl = parseFloat(poolInfo.totalValueLockedUSD ?? "0");

  console.log(`Pool: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`);
  console.log(`TVL: $${poolTvl.toLocaleString()}`);
  console.log(`Fee Tier: ${(feeTier * 100).toFixed(2)}%`);

  console.log("Fetching hourly data...");
  const hourlyData = await fetchAllPoolHourData(theGraphConfig);
  console.log(`Fetched ${hourlyData.length} hourly data points`);

  if (hourlyData.length === 0) {
    throw new Error("No hourly data available for the specified time range");
  }

  const series: MarketPoint[] = [];

  for (const hour of hourlyData) {
    const price = parseFloat(hour.close);
    const feesUsd = parseFloat(hour.feesUSD);
    const tvlUsd = parseFloat(hour.tvlUSD);
    const volumeUsd = parseFloat(hour.volumeUSD);

    const liquidityUsd = tvlUsd > 0 ? tvlUsd : poolTvl;
    const hourlyFeesApr = liquidityUsd > 0 ? (feesUsd / liquidityUsd) * 24 * 365 : backtestConfig.feesApr;

    series.push({
      ts: hour.periodStartUnix * 1000,
      price: price > 0 ? price : 1,
      feesApr: Math.min(hourlyFeesApr, 5),
      emissionsApr: backtestConfig.emissionsApr,
      liquidityUsd: liquidityUsd > 0 ? liquidityUsd : backtestConfig.liquidityUsd,
      gasUsd: backtestConfig.gasUsd,
      volumeUsd: volumeUsd > 0 ? volumeUsd : 0,
      feeTier
    });
  }

  if (backtestConfig.timeStepMinutes !== 60) {
    return resampleSeries(series, backtestConfig.timeStepMinutes);
  }

  return series;
}

function resampleSeries(series: MarketPoint[], targetStepMinutes: number): MarketPoint[] {
  if (series.length === 0) return [];

  const targetStepMs = targetStepMinutes * 60 * 1000;

  if (targetStepMinutes > 60) {
    const resampled: MarketPoint[] = [];
    const bucketSize = Math.floor(targetStepMinutes / 60);

    for (let i = 0; i < series.length; i += bucketSize) {
      const bucket = series.slice(i, i + bucketSize);
      if (bucket.length === 0) continue;

      const last = bucket[bucket.length - 1];
      const avgFeesApr = bucket.reduce((sum, p) => sum + p.feesApr, 0) / bucket.length;
      const avgEmissionsApr = bucket.reduce((sum, p) => sum + p.emissionsApr, 0) / bucket.length;
      const avgLiquidity = bucket.reduce((sum, p) => sum + p.liquidityUsd, 0) / bucket.length;

      const totalVolume = bucket.reduce((sum, p) => sum + p.volumeUsd, 0);
      resampled.push({
        ts: bucket[0].ts,
        price: last.price,
        feesApr: avgFeesApr,
        emissionsApr: avgEmissionsApr,
        liquidityUsd: avgLiquidity,
        gasUsd: last.gasUsd,
        volumeUsd: totalVolume,
        feeTier: last.feeTier
      });
    }

    return resampled;
  }

  if (targetStepMinutes < 60) {
    const interpolated: MarketPoint[] = [];
    const stepsPerHour = Math.floor(60 / targetStepMinutes);

    for (let i = 0; i < series.length - 1; i++) {
      const current = series[i];
      const next = series[i + 1];

      for (let j = 0; j < stepsPerHour; j++) {
        const t = j / stepsPerHour;
        const price = current.price + (next.price - current.price) * t;

        interpolated.push({
          ts: current.ts + j * targetStepMs,
          price,
          feesApr: current.feesApr,
          emissionsApr: current.emissionsApr,
          liquidityUsd: current.liquidityUsd,
          gasUsd: current.gasUsd,
          volumeUsd: current.volumeUsd / stepsPerHour, // Distribute volume
          feeTier: current.feeTier
        });
      }
    }

    interpolated.push(series[series.length - 1]);
    return interpolated;
  }

  return series;
}
