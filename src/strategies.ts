export type PoolType = "volatile" | "stable" | "cl";

export type Action =
  | { type: "REMOVE_LIQUIDITY"; percent: number }
  | { type: "ADD_LIQUIDITY"; lower: number; upper: number; amountUsd: number }
  | { type: "SWAP"; from: "base" | "quote"; amount: number }
  | { type: "CLAIM_REWARDS"; minUsd: number }
  | { type: "NOOP" };

export interface StrategyDecision {
  shouldRebalance: boolean;
  score: number; // Expected net gain in USD (higher is better).
  reason: string;
  actions: Action[];
  strategy?: string;
}

export interface Strategy {
  name: string;
  decide(ctx: StrategyContext): StrategyDecision;
}

export interface StrategyContext {
  pool: PoolSnapshot;
  vault: VaultState;
  params: RebalanceParams;
  nowMs: number;
}

export interface PoolSnapshot {
  type: PoolType;
  price: number; // quote per base
  twapShort: number; // e.g. 5m or 15m TWAP
  twapLong: number; // e.g. 1h or 4h TWAP
  vol: number; // annualized volatility, e.g. 0.7 = 70%
  feesApr: number; // fee APR, e.g. 0.25 = 25%
  emissionsApr: number; // reward APR, e.g. AERO
  liquidityUsd: number;
  gasUsd: number; // estimated gas cost for rebalance
}

export interface VaultState {
  baseBalance: number;
  quoteBalance: number;
  position?: PositionState;
  unclaimedRewardsUsd: number;
}

export interface PositionState {
  lower: number;
  upper: number;
  liquidityUsd: number;
  baseAmount: number;
  quoteAmount: number;
  lastRebalanceMs: number;
}

export interface RebalanceParams {
  minGasMultiple: number; // required fee gain multiple over gas cost
  targetRebalanceHours: number;
  bandWidthK: number; // volatility multiplier
  minBandWidth: number; // min width as fraction, e.g. 0.01 = 1%
  maxBandWidth: number; // max width as fraction
  driftThreshold: number; // max value drift before swap, e.g. 0.03
  trendThreshold: number; // momentum trigger, e.g. 0.005
  maxSkew: number; // max skew fraction
  rewardsClaimUsd: number;
}

export const defaultParams: RebalanceParams = {
  minGasMultiple: 1.5,
  targetRebalanceHours: 12,
  bandWidthK: 1.2,
  minBandWidth: 0.01,
  maxBandWidth: 0.25,
  driftThreshold: 0.03,
  trendThreshold: 0.006,
  maxSkew: 0.04,
  rewardsClaimUsd: 50,
};

export class RangeAroundTWAPStrategy implements Strategy {
  name = "range-around-twap";

  decide(ctx: StrategyContext): StrategyDecision {
    if (ctx.pool.type !== "cl") {
      return noop("CL-only strategy");
    }

    const center = ctx.pool.twapLong;
    const width = clamp(
      volToBandWidth(ctx.pool.vol, ctx.params.targetRebalanceHours, ctx.params.bandWidthK),
      ctx.params.minBandWidth,
      ctx.params.maxBandWidth
    );
    const lower = center * (1 - width);
    const upper = center * (1 + width);
    const position = ctx.vault.position;
    const priceOutOfRange =
      !position || ctx.pool.price < position.lower || ctx.pool.price > position.upper;

    const widthChanged =
      !position || Math.abs((position.upper - position.lower) / (2 * center) - width) > 0.005;

    if (!priceOutOfRange && !widthChanged) {
      return noop("Price inside range; width stable");
    }

    const expectedGainUsd = estimateFeeGain(ctx, totalVaultValue(ctx));
    if (!isWorthRebalance(ctx.pool.gasUsd, expectedGainUsd, ctx.params.minGasMultiple)) {
      return {
        shouldRebalance: false,
        score: expectedGainUsd - ctx.pool.gasUsd,
        reason: "Fee gain below gas threshold",
        actions: [{ type: "NOOP" }],
      };
    }

    return {
      shouldRebalance: true,
      score: expectedGainUsd - ctx.pool.gasUsd,
      reason: priceOutOfRange ? "Price out of range" : "Volatility regime shift",
      actions: [
        { type: "REMOVE_LIQUIDITY", percent: 1 },
        { type: "ADD_LIQUIDITY", lower, upper, amountUsd: totalVaultValue(ctx) },
      ],
    };
  }
}

export class TrendSkewStrategy implements Strategy {
  name = "trend-skew";

  decide(ctx: StrategyContext): StrategyDecision {
    if (ctx.pool.type !== "cl") {
      return noop("CL-only strategy");
    }

    const momentum = ctx.pool.twapShort / ctx.pool.twapLong - 1;
    if (Math.abs(momentum) < ctx.params.trendThreshold) {
      return noop("No trend signal");
    }

    const skew = clamp(momentum * 2, -ctx.params.maxSkew, ctx.params.maxSkew);
    const center = ctx.pool.price * (1 + skew);
    const width = clamp(
      volToBandWidth(ctx.pool.vol, ctx.params.targetRebalanceHours, ctx.params.bandWidthK),
      ctx.params.minBandWidth,
      ctx.params.maxBandWidth
    );
    const lower = center * (1 - width);
    const upper = center * (1 + width);

    const expectedGainUsd = estimateFeeGain(ctx, totalVaultValue(ctx));
    if (!isWorthRebalance(ctx.pool.gasUsd, expectedGainUsd, ctx.params.minGasMultiple)) {
      return {
        shouldRebalance: false,
        score: expectedGainUsd - ctx.pool.gasUsd,
        reason: "Trend detected but gas too high",
        actions: [{ type: "NOOP" }],
      };
    }

    return {
      shouldRebalance: true,
      score: expectedGainUsd - ctx.pool.gasUsd,
      reason: "Trend skew reposition",
      actions: [
        { type: "REMOVE_LIQUIDITY", percent: 1 },
        { type: "ADD_LIQUIDITY", lower, upper, amountUsd: totalVaultValue(ctx) },
      ],
    };
  }
}

export class InventoryTargetStrategy implements Strategy {
  name = "inventory-target";

  decide(ctx: StrategyContext): StrategyDecision {
    if (ctx.pool.type === "cl") {
      return noop("Non-CL inventory rebalance");
    }

    const baseValue = ctx.vault.baseBalance * ctx.pool.price;
    const quoteValue = ctx.vault.quoteBalance;
    const total = baseValue + quoteValue;
    if (total <= 0) {
      return noop("Empty vault");
    }

    const targetBaseValue = total * 0.5;
    const drift = (baseValue - targetBaseValue) / total;
    if (Math.abs(drift) < ctx.params.driftThreshold) {
      return noop("Inventory within drift threshold");
    }

    const valueToSwap = Math.abs(baseValue - targetBaseValue);
    const expectedGainUsd = estimateFeeGain(ctx, total);
    if (!isWorthRebalance(ctx.pool.gasUsd, expectedGainUsd, ctx.params.minGasMultiple)) {
      return {
        shouldRebalance: false,
        score: expectedGainUsd - ctx.pool.gasUsd,
        reason: "Inventory drift but gas too high",
        actions: [{ type: "NOOP" }],
      };
    }

    const from = drift > 0 ? "base" : "quote";
    const amount = from === "base" ? valueToSwap / ctx.pool.price : valueToSwap;
    return {
      shouldRebalance: true,
      score: expectedGainUsd - ctx.pool.gasUsd,
      reason: "Inventory drift rebalance",
      actions: [{ type: "SWAP", from, amount }],
    };
  }
}

export class RewardCompoundStrategy implements Strategy {
  name = "reward-compound";

  decide(ctx: StrategyContext): StrategyDecision {
    if (ctx.vault.unclaimedRewardsUsd < ctx.params.rewardsClaimUsd) {
      return noop("Rewards below threshold");
    }

    const expectedGainUsd = ctx.vault.unclaimedRewardsUsd;
    if (!isWorthRebalance(ctx.pool.gasUsd, expectedGainUsd, ctx.params.minGasMultiple)) {
      return {
        shouldRebalance: false,
        score: expectedGainUsd - ctx.pool.gasUsd,
        reason: "Rewards claim below gas threshold",
        actions: [{ type: "NOOP" }],
      };
    }

    return {
      shouldRebalance: true,
      score: expectedGainUsd - ctx.pool.gasUsd,
      reason: "Compound emissions",
      actions: [{ type: "CLAIM_REWARDS", minUsd: ctx.params.rewardsClaimUsd }],
    };
  }
}

export class StrategyRunner {
  constructor(private readonly strategies: Strategy[]) {}

  pickBest(ctx: StrategyContext): StrategyDecision {
    let best = noop("No strategies");
    for (const strategy of this.strategies) {
      const decision = strategy.decide(ctx);
      if (decision.shouldRebalance && decision.score > best.score) {
        best = { ...decision, strategy: strategy.name };
      }
    }
    return best;
  }
}

export function createDefaultStrategies(): Strategy[] {
  return [
    new RangeAroundTWAPStrategy(),
    new TrendSkewStrategy(),
    new InventoryTargetStrategy(),
    new RewardCompoundStrategy(),
  ];
}

function volToBandWidth(vol: number, targetHours: number, k: number): number {
  const yearHours = 365 * 24;
  const stdev = vol * Math.sqrt(targetHours / yearHours);
  return k * stdev;
}

function estimateFeeGain(ctx: StrategyContext, capitalUsd: number): number {
  const horizonDays = ctx.params.targetRebalanceHours / 24;
  const feeGain = capitalUsd * ctx.pool.feesApr * (horizonDays / 365);
  const rewardsGain = capitalUsd * ctx.pool.emissionsApr * (horizonDays / 365);
  return feeGain + rewardsGain;
}

function totalVaultValue(ctx: StrategyContext): number {
  const baseValue = ctx.vault.baseBalance * ctx.pool.price;
  const quoteValue = ctx.vault.quoteBalance;
  const positionValue = ctx.vault.position?.liquidityUsd ?? 0;
  return baseValue + quoteValue + positionValue;
}

function isWorthRebalance(gasUsd: number, expectedGainUsd: number, multiple: number): boolean {
  return expectedGainUsd >= gasUsd * multiple;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function noop(reason: string): StrategyDecision {
  return {
    shouldRebalance: false,
    score: -Infinity,
    reason,
    actions: [{ type: "NOOP" }],
  };
}
