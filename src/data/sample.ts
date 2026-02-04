import type { BacktestConfig, MarketPoint } from "../types.js";

interface SeededRng {
  next: () => number;
}

function createRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0xffffffff;
    }
  };
}

function randn(rng: SeededRng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gas Price Volatility Model
 *
 * 가스비는 다음 요소에 따라 변동:
 * 1. 시간대 - UTC 기준 미국 거래시간(14-22)에 높음
 * 2. 시장 변동성 - 가격 급변 시 가스비 급등
 * 3. 랜덤 스파이크 - NFT 민팅 등 예측 불가 이벤트
 *
 * L2 (Base, Arbitrum 등)는 L1보다 훨씬 안정적이고 저렴
 */
function calculateGasPrice(
  baseGasUsd: number,
  timestampMs: number,
  priceVolatility: number,
  isL2: boolean,
  rng: SeededRng
): number {
  // Time-of-day factor (UTC hours)
  const hour = new Date(timestampMs).getUTCHours();
  let timeFactor: number;
  if (hour >= 14 && hour <= 22) {
    // US trading hours - highest gas
    timeFactor = 1.3 + rng.next() * 0.4; // 1.3-1.7x
  } else if (hour >= 6 && hour <= 14) {
    // EU/Asia overlap - medium gas
    timeFactor = 1.0 + rng.next() * 0.3; // 1.0-1.3x
  } else {
    // Off-peak hours - lowest gas
    timeFactor = 0.7 + rng.next() * 0.3; // 0.7-1.0x
  }

  // Volatility factor - high volatility = high gas
  // Everyone rushes to trade during volatile periods
  const volFactor = 1 + priceVolatility * 2; // 50% vol → 2x gas

  // Random spike (simulates NFT mints, airdrops, etc.)
  // 5% chance of 2-5x spike
  const spikeRoll = rng.next();
  const spikeFactor = spikeRoll < 0.05 ? 2 + rng.next() * 3 : 1;

  // L2 has much more stable and lower gas
  const l2Discount = isL2 ? 0.3 : 1.0; // L2 is ~70% cheaper

  // L2 also has less volatility in gas prices
  const stabilityFactor = isL2 ? 0.5 : 1.0;

  const adjustedTimeFactor = 1 + (timeFactor - 1) * stabilityFactor;
  const adjustedSpikeFactor = 1 + (spikeFactor - 1) * stabilityFactor;

  return baseGasUsd * adjustedTimeFactor * volFactor * adjustedSpikeFactor * l2Discount;
}

/**
 * Volume-Volatility Relationship:
 *
 * 실제 시장에서 거래량과 변동성은 강한 양의 상관관계를 보입니다.
 * - 가격이 급등/급락할 때 거래량도 급증
 * - 횡보장에서는 거래량 감소
 *
 * 이 관계를 모델링하여 더 현실적인 fee 수입을 계산합니다.
 */
function calculateVolume(
  priceReturn: number,
  baseVolumeUsd: number,
  volatilityMultiplier: number,
  rng: SeededRng
): number {
  // 가격 변화의 절대값에 비례하여 거래량 증가
  const absReturn = Math.abs(priceReturn);
  const volMultiplier = 1 + absReturn * volatilityMultiplier;

  // 랜덤 노이즈 추가 (log-normal distribution for volume)
  const noise = Math.exp(randn(rng) * 0.3);

  // 시간대별 패턴 (실제로는 UTC 기준 미국/아시아 거래 시간에 거래량 증가)
  const hourNoise = 0.8 + rng.next() * 0.4;

  return baseVolumeUsd * volMultiplier * noise * hourNoise;
}

export function generateSampleSeries(config: BacktestConfig): MarketPoint[] {
  const stepMinutes = config.timeStepMinutes;
  const steps = Math.max(1, Math.floor((config.lookbackDays * 24 * 60) / stepMinutes));
  const stepMs = stepMinutes * 60 * 1000;
  const startMs = Date.now() - steps * stepMs;

  const rng = createRng(config.sample.seed);
  const volStep = config.sample.volDaily * Math.sqrt(stepMinutes / (24 * 60));
  const driftStep = config.sample.driftDaily / (24 * 60) * stepMinutes;

  // Fee tier based on pool type (default 0.3% for volatile pairs)
  const feeTier = config.rebalanceParams.feeTier ?? 0.003;

  // Base hourly volume (scaled from daily volume assumption)
  // Typical DEX pool might have 10-50% of TVL as daily volume
  const dailyVolumeRatio = 0.2; // 20% of TVL as daily volume
  const baseHourlyVolume = (config.liquidityUsd * dailyVolumeRatio) / 24;

  const series: MarketPoint[] = [];
  const returns: number[] = []; // Track returns for volatility calculation
  let price = config.sample.startPrice;
  let lastPrice = price;

  for (let i = 0; i < steps; i += 1) {
    const shock = randn(rng) * volStep;
    price = price * Math.exp(driftStep + shock);

    const priceReturn = i > 0 ? (price - lastPrice) / lastPrice : 0;
    if (i > 0) {
      returns.push(priceReturn);
    }

    // Volume correlates with volatility (거래량-변동성 상관관계)
    const volumeUsd = calculateVolume(
      priceReturn,
      baseHourlyVolume * (stepMinutes / 60), // Scale to time step
      50, // Volatility multiplier: 1% move → 1.5x volume
      rng
    );

    // Calculate fee APR from volume
    // Fee APR = (Volume × Fee Tier × 365 × 24) / (TVL × hours_per_step)
    // This represents annualized return if this volume persisted
    const hoursPerStep = stepMinutes / 60;
    const feesApr = (volumeUsd * feeTier * 365 * 24) / (config.liquidityUsd * hoursPerStep);

    const emissionNoise = (rng.next() - 0.5) * 0.02;
    const emissionsApr = clamp(config.emissionsApr * (1 + emissionNoise * 0.6), 0, 2);

    // Calculate dynamic gas price
    // Determine if this is L2 based on typical gas cost (L2 < $1, L1 > $5)
    const isL2 = config.gasUsd < 2;

    // Calculate rolling volatility for gas price model
    const recentReturns = returns.slice(-24); // Last 24 periods
    const rollingVol = recentReturns.length > 1
      ? Math.sqrt(recentReturns.reduce((sum, r) => sum + r * r, 0) / recentReturns.length) *
        Math.sqrt(365 * 24 * 60 / stepMinutes)
      : 0.5; // Default 50% vol

    const gasUsd = calculateGasPrice(
      config.gasUsd,
      startMs + i * stepMs,
      rollingVol,
      isL2,
      rng
    );

    series.push({
      ts: startMs + i * stepMs,
      price,
      feesApr: clamp(feesApr, 0, 2), // Cap at 200% APR
      emissionsApr,
      liquidityUsd: config.liquidityUsd,
      gasUsd,
      volumeUsd,
      feeTier
    });

    lastPrice = price;
  }

  return series;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
