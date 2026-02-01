# Aerodrome Rebalancing Vault Bot (Backtest + UI)

This repo contains a fully working backtest pipeline and dashboard for Aerodrome rebalancing strategies. It runs a deterministic backtest by default, stores results to `data/results.json`, and serves a frontend dashboard.

## Quick start

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Run a backtest manually

```bash
npm run backtest
```

Results are written to `data/results.json`. The UI reads this file automatically.

## Configure

Edit `config/backtest.json` to change:

- `poolType`: `cl`, `volatile`, or `stable`
- `feesApr`, `emissionsApr`, `gasUsd`
- `lookbackDays`, `timeStepMinutes`
- `rebalanceParams` (thresholds and range width settings)

### CSV data input

Set `dataSource` to `csv` and place a CSV at `data/series.csv` with headers:

```
timestamp,price,feesApr,emissionsApr,liquidityUsd,gasUsd
```

Timestamps should be in milliseconds.

## Scripts

- `npm run dev` starts the API + UI and auto-runs the backtest if missing
- `npm run backtest` runs once and writes `data/results.json`
- `npm run build` compiles TypeScript to `dist/`
- `npm run start` serves the compiled server

## 4가지 전략

### 1. Range Around TWAP
- **하는 일**: 평균 가격(TWAP) 주변에 유동성 범위 설정
- **비유**: "사람들이 많이 지나가는 길목에 가게 열기"

### 2. Trend Skew
- **하는 일**: 가격이 오르면 범위를 위로, 내리면 아래로 이동
- **비유**: "공이 가는 방향으로 미리 움직이기"

### 3. Inventory Target
- **하는 일**: ETH:USDC 비율을 50:50으로 유지
- **비유**: "한쪽에 너무 치우치지 않게 균형 맞추기"

### 4. Reward Compound
- **하는 일**: AERO 보상 받으면 재투자
- **비유**: "이자 받으면 다시 예금하기"
