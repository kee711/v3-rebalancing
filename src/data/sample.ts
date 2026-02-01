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

export function generateSampleSeries(config: BacktestConfig): MarketPoint[] {
  const stepMinutes = config.timeStepMinutes;
  const steps = Math.max(1, Math.floor((config.lookbackDays * 24 * 60) / stepMinutes));
  const stepMs = stepMinutes * 60 * 1000;
  const startMs = Date.now() - steps * stepMs;

  const rng = createRng(config.sample.seed);
  const volStep = config.sample.volDaily * Math.sqrt(stepMinutes / (24 * 60));
  const driftStep = config.sample.driftDaily / (24 * 60) * stepMinutes;

  const series: MarketPoint[] = [];
  let price = config.sample.startPrice;

  for (let i = 0; i < steps; i += 1) {
    const shock = randn(rng) * volStep;
    price = price * Math.exp(driftStep + shock);

    const noise = (rng.next() - 0.5) * 0.02;
    const feesApr = clamp(config.feesApr * (1 + noise), 0.01, 1.5);
    const emissionsApr = clamp(config.emissionsApr * (1 + noise * 0.6), 0, 2);

    series.push({
      ts: startMs + i * stepMs,
      price,
      feesApr,
      emissionsApr,
      liquidityUsd: config.liquidityUsd,
      gasUsd: config.gasUsd
    });
  }

  return series;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
