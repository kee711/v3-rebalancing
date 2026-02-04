/**
 * Uniswap V3 Concentrated Liquidity Math
 *
 * Key formulas:
 * - L = liquidity constant within a range
 * - When price P is in range [pL, pU]:
 *   - x (base) = L * (1/sqrt(P) - 1/sqrt(pU))
 *   - y (quote) = L * (sqrt(P) - sqrt(pL))
 * - When P < pL: position is 100% base
 * - When P > pU: position is 100% quote
 */

export interface V3Position {
  lower: number; // lower price bound
  upper: number; // upper price bound
  liquidity: number; // L
}

export interface V3Amounts {
  baseAmount: number;
  quoteAmount: number;
}

/**
 * Calculate base and quote amounts for a V3 position at a given price
 */
export function getAmountsForLiquidity(
  liquidity: number,
  lower: number,
  upper: number,
  price: number
): V3Amounts {
  const sqrtLower = Math.sqrt(lower);
  const sqrtUpper = Math.sqrt(upper);
  const sqrtPrice = Math.sqrt(price);

  let baseAmount: number;
  let quoteAmount: number;

  if (price <= lower) {
    // Price below range: 100% base, 0% quote
    baseAmount = liquidity * (1 / sqrtLower - 1 / sqrtUpper);
    quoteAmount = 0;
  } else if (price >= upper) {
    // Price above range: 0% base, 100% quote
    baseAmount = 0;
    quoteAmount = liquidity * (sqrtUpper - sqrtLower);
  } else {
    // Price in range: mix of base and quote
    baseAmount = liquidity * (1 / sqrtPrice - 1 / sqrtUpper);
    quoteAmount = liquidity * (sqrtPrice - sqrtLower);
  }

  return { baseAmount, quoteAmount };
}

/**
 * Calculate the USD value of a V3 position
 */
export function getPositionValueUsd(
  liquidity: number,
  lower: number,
  upper: number,
  price: number
): number {
  const { baseAmount, quoteAmount } = getAmountsForLiquidity(liquidity, lower, upper, price);
  return baseAmount * price + quoteAmount;
}

/**
 * Calculate the liquidity L from deposited USD amounts
 * Assumes depositing at current price with base:quote ratio appropriate for the range
 */
export function getLiquidityFromAmounts(
  baseAmount: number,
  quoteAmount: number,
  lower: number,
  upper: number,
  price: number
): number {
  const sqrtLower = Math.sqrt(lower);
  const sqrtUpper = Math.sqrt(upper);
  const sqrtPrice = Math.sqrt(Math.max(lower, Math.min(upper, price)));

  // L from base: L = baseAmount / (1/sqrtPrice - 1/sqrtUpper)
  // L from quote: L = quoteAmount / (sqrtPrice - sqrtLower)

  let liquidityFromBase = Infinity;
  let liquidityFromQuote = Infinity;

  if (price < upper) {
    const baseDenom = 1 / sqrtPrice - 1 / sqrtUpper;
    if (baseDenom > 0) {
      liquidityFromBase = baseAmount / baseDenom;
    }
  }

  if (price > lower) {
    const quoteDenom = sqrtPrice - sqrtLower;
    if (quoteDenom > 0) {
      liquidityFromQuote = quoteAmount / quoteDenom;
    }
  }

  // The effective liquidity is the minimum of the two
  // (limited by whichever asset runs out first)
  return Math.min(liquidityFromBase, liquidityFromQuote);
}

/**
 * Calculate how much base and quote is actually used when adding liquidity
 * Returns the amounts that will be consumed and the resulting liquidity
 */
export function addLiquidityAmounts(
  baseAvailable: number,
  quoteAvailable: number,
  lower: number,
  upper: number,
  price: number
): { baseUsed: number; quoteUsed: number; liquidity: number } {
  const sqrtLower = Math.sqrt(lower);
  const sqrtUpper = Math.sqrt(upper);

  // Clamp price to range for calculation
  const effectivePrice = Math.max(lower, Math.min(upper, price));
  const sqrtPrice = Math.sqrt(effectivePrice);

  if (price <= lower) {
    // Only base is used
    const baseDenom = 1 / sqrtLower - 1 / sqrtUpper;
    const liquidity = baseAvailable / baseDenom;
    return { baseUsed: baseAvailable, quoteUsed: 0, liquidity };
  }

  if (price >= upper) {
    // Only quote is used
    const quoteDenom = sqrtUpper - sqrtLower;
    const liquidity = quoteAvailable / quoteDenom;
    return { baseUsed: 0, quoteUsed: quoteAvailable, liquidity };
  }

  // In range: need both base and quote
  const baseDenom = 1 / sqrtPrice - 1 / sqrtUpper;
  const quoteDenom = sqrtPrice - sqrtLower;

  // Calculate L from each asset
  const liquidityFromBase = baseDenom > 0 ? baseAvailable / baseDenom : Infinity;
  const liquidityFromQuote = quoteDenom > 0 ? quoteAvailable / quoteDenom : Infinity;

  // Use the smaller L (limited by the scarcer asset)
  const liquidity = Math.min(liquidityFromBase, liquidityFromQuote);

  // Calculate actual amounts used
  const baseUsed = liquidity * baseDenom;
  const quoteUsed = liquidity * quoteDenom;

  return { baseUsed, quoteUsed, liquidity };
}

/**
 * Calculate effective swap price including spread and price impact
 *
 * @param midPrice - Current mid price
 * @param tradeValueUsd - Value of trade in USD
 * @param poolLiquidityUsd - Total pool liquidity in USD
 * @param isBuy - true if buying base (selling quote), false if selling base
 * @param spreadBps - Bid-ask spread in basis points
 * @param impactBps - Price impact per 1% of pool liquidity in basis points
 */
export function getEffectiveSwapPrice(
  midPrice: number,
  tradeValueUsd: number,
  poolLiquidityUsd: number,
  isBuy: boolean,
  spreadBps: number,
  impactBps: number
): number {
  // Spread: buy at higher price, sell at lower price
  const spreadFactor = spreadBps / 10000;

  // Price impact: larger trades move the price more
  const tradeRatio = tradeValueUsd / poolLiquidityUsd;
  const impactFactor = (impactBps / 10000) * (tradeRatio * 100); // impact per 1% of liquidity

  if (isBuy) {
    // Buying base: pay more than mid price
    return midPrice * (1 + spreadFactor / 2 + impactFactor);
  } else {
    // Selling base: receive less than mid price
    return midPrice * (1 - spreadFactor / 2 - impactFactor);
  }
}

/**
 * Calculate slippage cost for a swap
 */
export function getSlippageCost(
  tradeValueUsd: number,
  poolLiquidityUsd: number,
  spreadBps: number,
  impactBps: number
): number {
  const spreadFactor = spreadBps / 10000;
  const tradeRatio = tradeValueUsd / poolLiquidityUsd;
  const impactFactor = (impactBps / 10000) * (tradeRatio * 100);

  return tradeValueUsd * (spreadFactor / 2 + impactFactor);
}

/**
 * Calculate liquidity concentration factor for a V3 position
 *
 * V3 유동성 집중도:
 * - 넓은 range: 유동성이 분산되어 fee 점유율 낮음
 * - 좁은 range: 유동성이 집중되어 fee 점유율 높음
 *
 * concentration = sqrt(price) / (sqrt(upper) - sqrt(lower))
 *
 * 이 값이 클수록 같은 자본으로 더 많은 fee를 획득
 * 단, range 밖으로 나가면 fee = 0
 */
export function getLiquidityConcentration(
  lower: number,
  upper: number,
  price: number
): number {
  const sqrtLower = Math.sqrt(lower);
  const sqrtUpper = Math.sqrt(upper);
  const sqrtPrice = Math.sqrt(Math.max(lower, Math.min(upper, price)));

  // Concentration factor relative to full-range liquidity
  // Full range would be [0, ∞], which is impractical, so we compare to a "wide" range
  const rangeWidth = sqrtUpper - sqrtLower;
  if (rangeWidth <= 0) return 1;

  // The concentration is inversely proportional to range width
  // A position with half the range width has 2x the concentration
  return sqrtPrice / rangeWidth;
}

/**
 * Calculate MEV/Sandwich attack cost estimation
 *
 * 샌드위치 공격 비용은 다음 요소에 비례:
 * 1. 거래 규모 (클수록 더 큰 타겟)
 * 2. 풀 유동성 대비 거래 비율 (슬리피지가 클수록 이익 기회 증가)
 * 3. 시장 변동성 (높을수록 MEV 봇 활동 증가)
 * 4. 네트워크 상태 (혼잡할수록 샌드위치 기회 증가)
 *
 * @param tradeValueUsd - Trade value in USD
 * @param poolLiquidityUsd - Pool liquidity in USD
 * @param volatility - Current market volatility (annualized)
 * @param baseMevBps - Base MEV extraction rate in basis points (default 30 = 0.3%)
 */
export function estimateMevCost(
  tradeValueUsd: number,
  poolLiquidityUsd: number,
  volatility: number,
  baseMevBps: number = 30
): number {
  if (tradeValueUsd <= 0 || poolLiquidityUsd <= 0) {
    return 0;
  }

  // Size factor: larger trades are more attractive targets
  // Follows a logarithmic curve - diminishing returns for very large trades
  const tradeRatio = tradeValueUsd / poolLiquidityUsd;
  const sizeFactor = Math.min(2, 1 + Math.log10(1 + tradeRatio * 100));

  // Volatility factor: higher volatility = more MEV activity
  // Normalized assuming 50% annual vol as baseline
  const volFactor = Math.max(0.5, Math.min(2, volatility / 0.5));

  // Small trade discount: very small trades may not be profitable to sandwich
  // Below $500, MEV profit may not cover gas costs
  const smallTradeDiscount = tradeValueUsd < 500
    ? tradeValueUsd / 500
    : 1;

  // Calculate MEV cost
  const mevRate = (baseMevBps / 10000) * sizeFactor * volFactor * smallTradeDiscount;
  const mevCost = tradeValueUsd * mevRate;

  return mevCost;
}

/**
 * Calculate total rebalancing cost including gas, slippage, and MEV
 */
export function calculateRebalancingCost(
  tradeValueUsd: number,
  poolLiquidityUsd: number,
  gasUsd: number,
  volatility: number,
  spreadBps: number,
  impactBps: number,
  mevBps: number
): {
  gasUsd: number;
  slippageUsd: number;
  mevUsd: number;
  totalUsd: number;
} {
  const slippageUsd = getSlippageCost(tradeValueUsd, poolLiquidityUsd, spreadBps, impactBps);
  const mevUsd = estimateMevCost(tradeValueUsd, poolLiquidityUsd, volatility, mevBps);

  return {
    gasUsd,
    slippageUsd,
    mevUsd,
    totalUsd: gasUsd + slippageUsd + mevUsd
  };
}

/**
 * Calculate the fee share for a position based on its liquidity
 * relative to total pool liquidity in the active tick range
 *
 * @param positionLiquidity - Position's L value
 * @param positionLower - Position's lower price bound
 * @param positionUpper - Position's upper price bound
 * @param poolTvlUsd - Total pool TVL in USD
 * @param currentPrice - Current market price
 * @param avgPoolRangeWidth - Average range width of other LPs (as fraction, e.g., 0.1 = 10%)
 */
export function calculateFeeShare(
  positionLiquidity: number,
  positionLower: number,
  positionUpper: number,
  poolTvlUsd: number,
  currentPrice: number,
  avgPoolRangeWidth: number = 0.2 // Default: assume average LP has 20% range
): number {
  // Check if position is in range
  if (currentPrice < positionLower || currentPrice > positionUpper) {
    return 0; // Out of range = no fees
  }

  // Calculate position's concentration
  const positionConcentration = getLiquidityConcentration(
    positionLower,
    positionUpper,
    currentPrice
  );

  // Estimate "average" pool concentration
  // Assuming other LPs have wider ranges on average
  const avgLower = currentPrice * (1 - avgPoolRangeWidth);
  const avgUpper = currentPrice * (1 + avgPoolRangeWidth);
  const avgPoolConcentration = getLiquidityConcentration(avgLower, avgUpper, currentPrice);

  // Position value in current price
  const positionValueUsd = getPositionValueUsd(
    positionLiquidity,
    positionLower,
    positionUpper,
    currentPrice
  );

  // If pool TVL is 0 or position is entire pool, get 100%
  if (poolTvlUsd <= 0 || positionValueUsd >= poolTvlUsd) {
    return 1;
  }

  // Base share from capital ratio
  const capitalShare = positionValueUsd / poolTvlUsd;

  // Adjust by concentration ratio
  // If position is more concentrated than average, get more fees
  const concentrationRatio = avgPoolConcentration > 0
    ? positionConcentration / avgPoolConcentration
    : 1;

  // Final share (capped at 1)
  return Math.min(capitalShare * concentrationRatio, 1);
}
