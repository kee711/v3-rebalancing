const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const poolLabel = document.getElementById("poolLabel");
const dataPoints = document.getElementById("dataPoints");
const dataPeriod = document.getElementById("dataPeriod");
const lastPriceEl = document.getElementById("lastPrice");
const lastVolEl = document.getElementById("lastVol");
const rebalanceCount = document.getElementById("rebalanceCount");
const startValue = document.getElementById("startValue");
const endValue = document.getElementById("endValue");
const profitLoss = document.getElementById("profitLoss");
const totalReturnEl = document.getElementById("totalReturn");
const annualizedEl = document.getElementById("annualized");
const maxDrawdownEl = document.getElementById("maxDrawdown");
const feesEl = document.getElementById("fees");
const emissionsEl = document.getElementById("emissions");
const gasEl = document.getElementById("gas");
const actionsBody = document.getElementById("actionsBody");
const totalActions = document.getElementById("totalActions");
const actionsSummary = document.getElementById("actionsSummary");
const configDump = document.getElementById("configDump");

// Evidence elements
const dataSource = document.getElementById("dataSource");
const subgraphInfo = document.getElementById("subgraphInfo");
const startDate = document.getElementById("startDate");
const endDate = document.getElementById("endDate");
const hoursAnalyzed = document.getElementById("hoursAnalyzed");
const generatedAt = document.getElementById("generatedAt");

let equityChartInstance = null;
let priceChartInstance = null;

runBtn.addEventListener("click", async () => {
  await fetchResults(true);
});

async function fetchResults(force) {
  setStatus(force ? "Running backtest... (fetching data from The Graph)" : "Loading...");
  runBtn.disabled = true;

  try {
    if (force) {
      await fetch("/api/run?force=1", { method: "POST" });
    }
    const res = await fetch("/api/results");
    const data = await res.json();

    const cfgRes = await fetch("/api/config");
    const cfg = await cfgRes.json();

    render(data, cfg);
    setStatus("Ready");
  } catch (err) {
    console.error(err);
    setStatus("Failed to load results");
  } finally {
    runBtn.disabled = false;
  }
}

function render(result, config) {
  // Meta info
  poolLabel.textContent = `${result.meta.symbol} · ${result.meta.poolType.toUpperCase()}`;
  dataPoints.textContent = `${result.meta.points.toLocaleString()} points`;

  // Calculate period
  const firstTs = result.equityCurve[0]?.ts;
  const lastTs = result.equityCurve[result.equityCurve.length - 1]?.ts;
  const days = Math.round((lastTs - firstTs) / (1000 * 60 * 60 * 24));
  dataPeriod.textContent = `${days} days`;

  lastPriceEl.textContent = formatUsd(result.lastSnapshot.price);
  lastVolEl.textContent = `${(result.lastSnapshot.vol * 100).toFixed(2)}%`;
  rebalanceCount.textContent = result.summary.rebalances.toLocaleString();

  // Performance
  startValue.textContent = formatUsd(result.summary.startValueUsd);
  endValue.textContent = formatUsd(result.summary.endValueUsd);

  const pl = result.summary.endValueUsd - result.summary.startValueUsd;
  profitLoss.textContent = `${pl >= 0 ? '+' : ''}${formatUsd(pl)}`;
  profitLoss.className = pl >= 0 ? 'profit' : 'loss';

  totalReturnEl.textContent = formatPct(result.summary.totalReturnPct);
  totalReturnEl.className = result.summary.totalReturnPct >= 0 ? 'profit' : 'loss';

  annualizedEl.textContent = formatPct(result.summary.annualizedReturnPct);
  annualizedEl.className = result.summary.annualizedReturnPct >= 0 ? 'profit' : 'loss';

  maxDrawdownEl.textContent = formatPct(result.summary.maxDrawdownPct);
  feesEl.textContent = formatUsd(result.summary.feesUsd);
  emissionsEl.textContent = formatUsd(result.summary.emissionsUsd);
  gasEl.textContent = formatUsd(result.summary.gasUsd);

  // Evidence section
  dataSource.textContent = config.dataSource === 'thegraph' ? 'The Graph (Live Data)' : config.dataSource;
  subgraphInfo.textContent = config.theGraph?.subgraphId
    ? `${config.theGraph.subgraphId.slice(0, 8)}...`
    : 'N/A';
  startDate.textContent = new Date(firstTs).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  endDate.textContent = new Date(lastTs).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  hoursAnalyzed.textContent = `${result.meta.points.toLocaleString()} hours`;
  generatedAt.textContent = new Date(result.meta.generatedAt).toLocaleString();

  // Charts
  renderEquityChart(result.equityCurve);
  renderPriceChart(result.equityCurve);

  // Actions
  renderActions(result.actions);

  // Config
  configDump.textContent = JSON.stringify(config, null, 2);
}

function renderEquityChart(curve) {
  const labels = curve.map((point) => {
    const d = new Date(point.ts);
    return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:00`;
  });
  const values = curve.map((point) => point.valueUsd);
  const ctx = document.getElementById("equityChart").getContext("2d");

  if (equityChartInstance) {
    equityChartInstance.destroy();
  }

  equityChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Portfolio Value (USD)",
          data: values,
          borderColor: "#f2b544",
          backgroundColor: "rgba(242, 181, 68, 0.15)",
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `$${ctx.parsed.y.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#a8b7b2", maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: "rgba(242, 181, 68, 0.08)" }
        },
        y: {
          ticks: {
            color: "#a8b7b2",
            callback: (v) => '$' + v.toLocaleString()
          },
          grid: { color: "rgba(242, 181, 68, 0.08)" }
        }
      }
    }
  });
}

function renderPriceChart(curve) {
  const labels = curve.map((point) => {
    const d = new Date(point.ts);
    return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:00`;
  });

  // Use actual price data from the backtest
  const prices = curve.map((point) => point.price);

  const ctx = document.getElementById("priceChart").getContext("2d");

  if (priceChartInstance) {
    priceChartInstance.destroy();
  }

  priceChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "ETH Price (USD)",
          data: prices,
          borderColor: "#7bdff2",
          backgroundColor: "rgba(123, 223, 242, 0.1)",
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `$${ctx.parsed.y.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#a8b7b2", maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: "rgba(123, 223, 242, 0.08)" }
        },
        y: {
          ticks: {
            color: "#a8b7b2",
            callback: (v) => '$' + v.toLocaleString()
          },
          grid: { color: "rgba(123, 223, 242, 0.08)" }
        }
      }
    }
  });
}

function renderActions(actions) {
  actionsBody.innerHTML = "";
  totalActions.textContent = actions.length;

  if (actions.length === 0) {
    actionsBody.innerHTML = "<tr><td colspan=\"6\">No rebalance actions during this period</td></tr>";
    actionsSummary.textContent = "No actions taken.";
    return;
  }

  // Show all actions (reversed to show newest first)
  const allActions = [...actions].reverse();

  allActions.forEach((action, idx) => {
    const row = document.createElement("tr");
    const actionNum = actions.length - idx;
    row.innerHTML = `
      <td>${actionNum}</td>
      <td>${new Date(action.ts).toLocaleString()}</td>
      <td><span class="strategy-badge">${action.strategy}</span></td>
      <td>${action.reason}</td>
      <td>${action.actions.join(", ")}</td>
      <td>${formatUsd(action.gasUsd)}</td>
    `;
    actionsBody.appendChild(row);
  });

  // Strategy breakdown
  const strategyCounts = {};
  actions.forEach(a => {
    strategyCounts[a.strategy] = (strategyCounts[a.strategy] || 0) + 1;
  });

  const breakdown = Object.entries(strategyCounts)
    .map(([s, c]) => `${s}: ${c}`)
    .join(' | ');

  actionsSummary.textContent = `Strategy breakdown: ${breakdown}`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

fetchResults(false);
