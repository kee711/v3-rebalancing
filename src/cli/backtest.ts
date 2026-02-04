import fs from "fs";
import { loadConfig } from "../config.js";
import { runWithConfig, resultsPath } from "../backtest/run.js";

async function main() {
  const config = loadConfig();

  console.log(`Running backtest with dataSource: ${config.dataSource}`);
  const result = await runWithConfig(config);

  fs.writeFileSync(resultsPath(), JSON.stringify(result, null, 2));

  const summary = result.summary;
  console.log("\nBacktest complete");
  console.log(`Start USD: ${summary.startValueUsd.toFixed(2)}`);
  console.log(`End USD: ${summary.endValueUsd.toFixed(2)}`);
  console.log(`Total return: ${summary.totalReturnPct.toFixed(2)}%`);
  console.log(`Annualized: ${summary.annualizedReturnPct.toFixed(2)}%`);
  console.log(`Fees: ${summary.feesUsd.toFixed(2)}`);
  console.log(`Emissions: ${summary.emissionsUsd.toFixed(2)}`);
  console.log(`Gas: ${summary.gasUsd.toFixed(2)}`);
  console.log(`MEV Cost: ${summary.mevUsd.toFixed(2)}`);
  console.log(`Rebalances: ${summary.rebalances}`);
  console.log(`Max Drawdown: ${summary.maxDrawdownPct.toFixed(2)}%`);
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
