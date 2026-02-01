import {
  StrategyRunner,
  type PoolSnapshot,
  type StrategyContext,
  type StrategyDecision,
  type VaultState,
  createDefaultStrategies
} from "../strategies.js";
import type { BacktestConfig, BacktestResult, MarketPoint } from "../types.js";

interface RunningStats {
  feesUsd: number;
  emissionsUsd: number;
  gasUsd: number;
  rebalances: number;
}

export function runBacktest(config: BacktestConfig, series: MarketPoint[]): BacktestResult {
  if (series.length === 0) {
    throw new Error("No market data points available");
  }

  const runner = new StrategyRunner(createDefaultStrategies());
  const returns: number[] = [];
  const prices: number[] = [];
  const equityCurve: { ts: number; valueUsd: number; price: number }[] = [];
  const actionsLog: BacktestResult["actions"] = [];

  const volWindowSteps = Math.max(2, Math.round((config.windows.volDays * 24 * 60) / config.timeStepMinutes));
  const twapShortSteps = Math.max(2, Math.round((config.windows.twapShortHours * 60) / config.timeStepMinutes));
  const twapLongSteps = Math.max(2, Math.round((config.windows.twapLongHours * 60) / config.timeStepMinutes));

  const stats: RunningStats = {
    feesUsd: 0,
    emissionsUsd: 0,
    gasUsd: 0,
    rebalances: 0
  };

  let lastPrice = series[0].price;
  let vault: VaultState = {
    baseBalance: config.initialCapitalUsd / 2 / lastPrice,
    quoteBalance: config.initialCapitalUsd / 2,
    position: undefined,
    unclaimedRewardsUsd: 0
  };

  for (let i = 0; i < series.length; i += 1) {
    const point = series[i];
    const price = point.price;

    if (i > 0) {
      returns.push(Math.log(price / lastPrice));
    }
    prices.push(price);

    const vol = computeAnnualizedVol(returns, volWindowSteps, config.timeStepMinutes);
    const twapShort = computeTwap(prices, twapShortSteps);
    const twapLong = computeTwap(prices, twapLongSteps);

    const feesApr = Number.isFinite(point.feesApr) ? point.feesApr : config.feesApr;
    const emissionsApr = Number.isFinite(point.emissionsApr) ? point.emissionsApr : config.emissionsApr;
    const liquidityUsd = Number.isFinite(point.liquidityUsd) && point.liquidityUsd > 0 ? point.liquidityUsd : config.liquidityUsd;
    const gasUsd = Number.isFinite(point.gasUsd) && point.gasUsd >= 0 ? point.gasUsd : config.gasUsd;

    const poolSnapshot: PoolSnapshot = {
      type: config.poolType,
      price,
      twapShort,
      twapLong,
      vol,
      feesApr,
      emissionsApr,
      liquidityUsd,
      gasUsd
    };

    const dtDays = config.timeStepMinutes / (24 * 60);
    updateVault(vault, poolSnapshot, lastPrice, price, dtDays, stats);

    if (!vault.position && config.poolType === "cl") {
      seedInitialPosition(vault, poolSnapshot, config);
    }

    const ctx: StrategyContext = {
      pool: poolSnapshot,
      vault,
      params: config.rebalanceParams,
      nowMs: point.ts
    };

    if (i > 0) {
      const decision = runner.pickBest(ctx);
      if (decision.shouldRebalance) {
        const actionLog = applyDecision(vault, poolSnapshot, decision, stats, point.ts);
        if (actionLog) {
          actionsLog.push(actionLog);
        }
      }
    }

    const totalValue = totalVaultValue(vault, price);
    equityCurve.push({ ts: point.ts, valueUsd: totalValue, price });

    lastPrice = price;
  }

  const startValueUsd = equityCurve[0]?.valueUsd ?? config.initialCapitalUsd;
  const endValueUsd = equityCurve[equityCurve.length - 1]?.valueUsd ?? startValueUsd;
  const totalReturnPct = ((endValueUsd - startValueUsd) / startValueUsd) * 100;
  const annualizedReturnPct = annualizeReturn(totalReturnPct, config.lookbackDays);

  const summary = {
    startValueUsd,
    endValueUsd,
    totalReturnPct,
    annualizedReturnPct,
    feesUsd: stats.feesUsd,
    emissionsUsd: stats.emissionsUsd,
    gasUsd: stats.gasUsd,
    rebalances: stats.rebalances,
    maxDrawdownPct: computeMaxDrawdown(equityCurve)
  };

  const last = series[series.length - 1];

  return {
    meta: {
      generatedAt: Date.now(),
      symbol: config.symbol,
      poolType: config.poolType,
      points: series.length
    },
    summary,
    equityCurve,
    actions: actionsLog,
    lastSnapshot: {
      ts: last.ts,
      price: last.price,
      twapShort: computeTwap(prices, twapShortSteps),
      twapLong: computeTwap(prices, twapLongSteps),
      vol: computeAnnualizedVol(returns, volWindowSteps, config.timeStepMinutes)
    }
  };
}

function seedInitialPosition(vault: VaultState, pool: PoolSnapshot, config: BacktestConfig): void {
  const width = clamp(
    volToBandWidth(pool.vol, config.rebalanceParams.targetRebalanceHours, config.rebalanceParams.bandWidthK),
    config.rebalanceParams.minBandWidth,
    config.rebalanceParams.maxBandWidth
  );
  const lower = pool.price * (1 - width);
  const upper = pool.price * (1 + width);
  const totalUsd = totalVaultValue(vault, pool.price);

  vault.position = {
    lower,
    upper,
    liquidityUsd: totalUsd,
    baseAmount: totalUsd / 2 / pool.price,
    quoteAmount: totalUsd / 2,
    lastRebalanceMs: Date.now()
  };
  vault.baseBalance = 0;
  vault.quoteBalance = 0;
}

function updateVault(
  vault: VaultState,
  pool: PoolSnapshot,
  lastPrice: number,
  price: number,
  dtDays: number,
  stats: RunningStats
): void {
  if (vault.position) {
    const priceReturn = lastPrice > 0 ? price / lastPrice - 1 : 0;
    vault.position.liquidityUsd *= 1 + priceReturn / 2;

    if (price >= vault.position.lower && price <= vault.position.upper) {
      const fees = vault.position.liquidityUsd * pool.feesApr * (dtDays / 365);
      vault.position.liquidityUsd += fees;
      stats.feesUsd += fees;

      const rewards = vault.position.liquidityUsd * pool.emissionsApr * (dtDays / 365);
      vault.unclaimedRewardsUsd += rewards;
      stats.emissionsUsd += rewards;
    }
  } else if (pool.type !== "cl") {
    const total = totalVaultValue(vault, price);
    if (total > 0) {
      const fees = total * pool.feesApr * (dtDays / 365);
      vault.quoteBalance += fees;
      stats.feesUsd += fees;

      const rewards = total * pool.emissionsApr * (dtDays / 365);
      vault.unclaimedRewardsUsd += rewards;
      stats.emissionsUsd += rewards;
    }
  }
}

function applyDecision(
  vault: VaultState,
  pool: PoolSnapshot,
  decision: StrategyDecision,
  stats: RunningStats,
  ts: number
): BacktestResult["actions"][number] | null {
  const hasRealAction = decision.actions.some((action) => action.type !== "NOOP");
  if (!hasRealAction) {
    return null;
  }

  if (!decision.strategy) {
    decision.strategy = "unknown";
  }

  deductGas(vault, pool.gasUsd, pool.price);
  stats.gasUsd += pool.gasUsd;
  stats.rebalances += 1;

  for (const action of decision.actions) {
    switch (action.type) {
      case "REMOVE_LIQUIDITY":
        removeLiquidity(vault, pool.price, action.percent);
        break;
      case "ADD_LIQUIDITY":
        addLiquidity(vault, pool.price, action.lower, action.upper, action.amountUsd, ts);
        break;
      case "SWAP":
        swapInventory(vault, pool.price, action.from, action.amount);
        break;
      case "CLAIM_REWARDS":
        claimRewards(vault);
        break;
      case "NOOP":
        break;
      default:
        assertNever(action);
    }
  }

  return {
    ts,
    strategy: decision.strategy,
    reason: decision.reason,
    actions: decision.actions.map((action) => action.type),
    gasUsd: pool.gasUsd
  };
}

function removeLiquidity(vault: VaultState, price: number, percent: number): void {
  if (!vault.position) {
    return;
  }

  const clamped = clamp(percent, 0, 1);
  const removeUsd = vault.position.liquidityUsd * clamped;
  const baseOut = removeUsd / 2 / price;
  const quoteOut = removeUsd / 2;

  vault.baseBalance += baseOut;
  vault.quoteBalance += quoteOut;
  vault.position.liquidityUsd -= removeUsd;

  if (vault.position.liquidityUsd <= 0.01) {
    vault.position = undefined;
  }
}

function addLiquidity(
  vault: VaultState,
  price: number,
  lower: number,
  upper: number,
  amountUsd: number,
  ts: number
): void {
  const maxUsd = Math.min(vault.baseBalance * price * 2, vault.quoteBalance * 2);
  const usedUsd = Math.max(0, Math.min(amountUsd, maxUsd));
  if (usedUsd <= 0) {
    return;
  }

  const baseUsed = usedUsd / 2 / price;
  const quoteUsed = usedUsd / 2;

  vault.baseBalance -= baseUsed;
  vault.quoteBalance -= quoteUsed;

  vault.position = {
    lower,
    upper,
    liquidityUsd: usedUsd,
    baseAmount: baseUsed,
    quoteAmount: quoteUsed,
    lastRebalanceMs: ts
  };
}

function swapInventory(vault: VaultState, price: number, from: "base" | "quote", amount: number): void {
  if (amount <= 0) {
    return;
  }

  if (from === "base") {
    const baseUsed = Math.min(amount, vault.baseBalance);
    vault.baseBalance -= baseUsed;
    vault.quoteBalance += baseUsed * price;
  } else {
    const quoteUsed = Math.min(amount, vault.quoteBalance);
    vault.quoteBalance -= quoteUsed;
    vault.baseBalance += quoteUsed / price;
  }
}

function claimRewards(vault: VaultState): void {
  if (vault.unclaimedRewardsUsd <= 0) {
    return;
  }
  vault.quoteBalance += vault.unclaimedRewardsUsd;
  vault.unclaimedRewardsUsd = 0;
}

function deductGas(vault: VaultState, gasUsd: number, price: number): void {
  if (gasUsd <= 0) {
    return;
  }

  if (vault.quoteBalance >= gasUsd) {
    vault.quoteBalance -= gasUsd;
    return;
  }

  const shortfall = gasUsd - vault.quoteBalance;
  vault.quoteBalance = 0;
  const baseNeeded = shortfall / price;
  vault.baseBalance = Math.max(0, vault.baseBalance - baseNeeded);
}

function totalVaultValue(vault: VaultState, price: number): number {
  const baseValue = vault.baseBalance * price;
  const quoteValue = vault.quoteBalance;
  const positionValue = vault.position?.liquidityUsd ?? 0;
  return baseValue + quoteValue + positionValue;
}

function computeTwap(prices: number[], window: number): number {
  if (prices.length === 0) {
    return 0;
  }
  const start = Math.max(0, prices.length - window);
  const slice = prices.slice(start);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function computeAnnualizedVol(returns: number[], window: number, stepMinutes: number): number {
  const size = returns.length;
  if (size < 2) {
    return 0;
  }
  const start = Math.max(0, size - window);
  const slice = returns.slice(start);
  if (slice.length < 2) {
    return 0;
  }
  const mean = slice.reduce((acc, value) => acc + value, 0) / slice.length;
  const variance = slice.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / (slice.length - 1);
  const stdev = Math.sqrt(variance);
  const annualFactor = Math.sqrt((365 * 24 * 60) / stepMinutes);
  return stdev * annualFactor;
}

function computeMaxDrawdown(equity: { ts: number; valueUsd: number }[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of equity) {
    if (point.valueUsd > peak) {
      peak = point.valueUsd;
    }
    const drawdown = peak > 0 ? (peak - point.valueUsd) / peak : 0;
    if (drawdown > maxDd) {
      maxDd = drawdown;
    }
  }
  return maxDd * 100;
}

function annualizeReturn(totalReturnPct: number, days: number): number {
  if (days <= 0) {
    return totalReturnPct;
  }
  const totalReturn = totalReturnPct / 100;
  const years = days / 365;
  const annualized = Math.pow(1 + totalReturn, 1 / years) - 1;
  return annualized * 100;
}

function volToBandWidth(vol: number, targetHours: number, k: number): number {
  const yearHours = 365 * 24;
  const stdev = vol * Math.sqrt(targetHours / yearHours);
  return k * stdev;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function assertNever(_: never): never {
  throw new Error("Unhandled action type");
}
