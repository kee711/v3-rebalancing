import fs from "fs";
import path from "path";
import type { MarketPoint } from "../types.js";

const DEFAULT_CSV_PATH = path.join(process.cwd(), "data", "series.csv");

export function loadCsvSeries(filePath = DEFAULT_CSV_PATH): MarketPoint[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const header = lines.shift();
  if (!header) {
    return [];
  }

  const columns = header.split(",").map((value) => value.trim());
  const idx = {
    ts: columns.indexOf("timestamp"),
    price: columns.indexOf("price"),
    feesApr: columns.indexOf("feesApr"),
    emissionsApr: columns.indexOf("emissionsApr"),
    liquidityUsd: columns.indexOf("liquidityUsd"),
    gasUsd: columns.indexOf("gasUsd")
  };

  if (idx.ts < 0 || idx.price < 0) {
    throw new Error("CSV must include timestamp and price columns");
  }

  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split(",");
      return {
        ts: Number(parts[idx.ts]),
        price: Number(parts[idx.price]),
        feesApr: idx.feesApr >= 0 ? Number(parts[idx.feesApr]) : 0,
        emissionsApr: idx.emissionsApr >= 0 ? Number(parts[idx.emissionsApr]) : 0,
        liquidityUsd: idx.liquidityUsd >= 0 ? Number(parts[idx.liquidityUsd]) : 0,
        gasUsd: idx.gasUsd >= 0 ? Number(parts[idx.gasUsd]) : 0
      } as MarketPoint;
    })
    .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.ts));
}
