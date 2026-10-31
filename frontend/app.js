// ============================================================
// Constants
// ============================================================
// Auto-detects local dev vs production so this never has to be toggled by
// hand before a deploy — a source of past mistakes.
const BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://loanniti-backend-production.up.railway.app';
const MAX_INPUT_CHARS = 400;
const MAX_MESSAGES_PER_SESSION = 10;
const COOLDOWN_SECONDS = 3;

const INJECTION_PATTERNS = [
  /ignore\s+instructions?/i,
  /jailbreak/i,
  /you\s+are\s+now/i,
  /act\s+as\s+(a\s+)?different/i,
  /reveal\s+your\s+prompt/i,
];

// ============================================================
// Shared calculation helpers (mirrors backend/utils/emiCalculations.js)
// ============================================================
function formatINR(amount) {
  const abs = Math.abs(amount);
  if (abs >= 1e7) return `₹${(amount / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `₹${(amount / 1e5).toFixed(1)}L`;
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

function computeEMI(principal, annualRate, tenureYears) {
  const r = annualRate / 12 / 100;
  const n = tenureYears * 12;
  if (r === 0) return principal / n;
  const pow = Math.pow(1 + r, n);
  return (principal * r * pow) / (pow - 1);
}

// Inverse of computeEMI: given an affordable EMI, what principal does that buy?
function maxLoanForEmi(emi, annualRate, tenureYears) {
  const r = annualRate / 12 / 100;
  const n = tenureYears * 12;
  if (r === 0) return emi * n;
  const pow = Math.pow(1 + r, n);
  return (emi * (pow - 1)) / (r * pow);
}

// SIP future value (annuity due — contribution at the start of each month),
// the convention Indian SIP calculators use.
function sipFutureValue(monthlyAmount, annualReturnPercent, months) {
  const i = annualReturnPercent / 12 / 100;
  if (i === 0) return monthlyAmount * months;
  return monthlyAmount * ((Math.pow(1 + i, months) - 1) / i) * (1 + i);
}

function buildAmortizationSchedule(principal, annualRate, tenureYears) {
  const r = annualRate / 12 / 100;
  const n = tenureYears * 12;
  const emi = computeEMI(principal, annualRate, tenureYears);
  let balance = principal;
  const monthly = [];
  for (let month = 1; month <= n; month++) {
    const interest = balance * r;
    let principalPaid = emi - interest;
    if (principalPaid > balance) principalPaid = balance;
    balance -= principalPaid;
    if (balance < 0) balance = 0;
    monthly.push({ month, interest, principalPaid, balance });
    if (balance <= 0) break;
  }
  return { emi, monthly };
}

function yearlyFromMonthly(monthly) {
  const years = [];
  for (let i = 0; i < monthly.length; i += 12) {
    const chunk = monthly.slice(i, i + 12);
    const principalPaid = chunk.reduce((s, m) => s + m.principalPaid, 0);
    const interestPaid = chunk.reduce((s, m) => s + m.interest, 0);
    years.push({
      year: years.length + 1,
      principalPaid,
      interestPaid,
      totalPaid: principalPaid + interestPaid,
      closingBalance: chunk[chunk.length - 1].balance,
    });
  }
  return years;
}

function simulateWithPrepayment(principal, annualRate, tenureYears, options = {}) {
  const { lumpSum = 0, lumpSumMonth = 0, extraMonthly = 0, annualHikePercent = 0, annualLumpSum = 0 } = options;
  const r = annualRate / 12 / 100;
  const baseN = tenureYears * 12;
  const baseEmi = computeEMI(principal, annualRate, tenureYears);

  let balance = principal;
  let currentEmi = baseEmi;
  let month = 0;
  let totalInterest = 0;
  const maxMonths = baseN + 12;
  const monthly = [];

  while (balance > 1 && month < maxMonths) {
    month++;
    if (annualHikePercent > 0 && month > 1 && (month - 1) % 12 === 0) {
      currentEmi = currentEmi * (1 + annualHikePercent / 100);
    }
    const interest = balance * r;
    let payment = currentEmi + extraMonthly;
    let principalPaid = payment - interest;

    if (month === lumpSumMonth && lumpSum > 0) {
      principalPaid += lumpSum;
    }
    if (annualLumpSum > 0 && month % 12 === 0) {
      principalPaid += annualLumpSum;
    }
    if (principalPaid > balance) principalPaid = balance;
    if (principalPaid < 0) principalPaid = 0;

    balance -= principalPaid;
    totalInterest += interest;
    monthly.push({ month, balance });

    if (balance <= 0) { balance = 0; break; }
  }

  return { months: month, years: month / 12, totalInterest, totalPayment: principal + totalInterest, monthly };
}

// ============================================================
// Theme
// ============================================================
const themeToggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';
  try { localStorage.setItem('loanniti-theme', theme); } catch (e) {}
}
(function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('loanniti-theme') || 'dark'; } catch (e) {}
  applyTheme(saved);
})();
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
  refreshChartColors();
});

function refreshChartColors() {
  const color = chartTextColor();
  [doughnutChart, stackedBarChart, balanceChart, compareChart].forEach((chart) => {
    if (!chart) return;
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = color;
    if (chart.options.scales) {
      Object.values(chart.options.scales).forEach((scale) => {
        if (scale.ticks) scale.ticks.color = color;
      });
    }
    chart.update();
  });
}

// ============================================================
// Tabs
// ============================================================
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'planner') renderPlanner();
    if (btn.dataset.tab === 'compare') renderCompareResults();
    if (btn.dataset.tab === 'eligibility') renderEligibility();
    if (btn.dataset.tab === 'sip') renderSipComparison();
    if (btn.dataset.tab === 'chat') updateContextPill();
  });
});

// ============================================================
// Alerts
// ============================================================
function showAlert(message, type = 'error') {
  const container = document.getElementById('alertContainer');
  const el = document.createElement('div');
  el.className = 'alert-banner' + (type === 'warning' ? ' warning' : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ============================================================
// Tab 1: EMI Calculator
// ============================================================
const amountSlider = document.getElementById('amountSlider');
const rateSlider = document.getElementById('rateSlider');
const tenureSlider = document.getElementById('tenureSlider');
const loanTypeSelect = document.getElementById('loanType');

const loanState = { amount: 2500000, rate: 9.5, tenure: 20, loanType: 'floating', emi: 0, totalInterest: 0 };

let doughnutChart, stackedBarChart, balanceChart;
let loanMode = 'new';

const LOAN_MODE_TEXT = {
  new: {
    amountLabel: 'Loan amount',
    tenureLabel: 'Tenure',
    hint: "Planning a new loan — enter the full amount and tenure you're taking.",
  },
  existing: {
    amountLabel: 'Outstanding balance',
    tenureLabel: 'Remaining tenure',
    hint: "Already repaying this loan — enter today's outstanding balance and however many years are left, not the original numbers. All figures below (EMI, interest, amortization) will reflect where you are right now.",
  },
};

function applyLoanMode(mode) {
  loanMode = mode;
  const t = LOAN_MODE_TEXT[mode];

  document.querySelectorAll('#loanModeTabs .strategy-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  document.getElementById('amountFieldLabel').textContent = t.amountLabel;
  document.getElementById('tenureFieldLabel').textContent = t.tenureLabel;
  document.getElementById('loanModeHint').textContent = t.hint;

  document.getElementById('plannerAmountFieldLabel').textContent = t.amountLabel + ' (₹)';
  document.getElementById('plannerTenureFieldLabel').textContent = t.tenureLabel + ' (years)';
  document.getElementById('plannerLoanModeHint').textContent = t.hint + ' (Set this on the EMI Calculator tab.)';
  document.getElementById('amortModeHint').style.display = mode === 'existing' ? '' : 'none';
}

document.getElementById('loanModeTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.strategy-tab');
  if (tab) applyLoanMode(tab.dataset.mode);
});

function updateCalculatorLabels() {
  document.getElementById('amountLabel').textContent = formatINR(loanState.amount);
  document.getElementById('rateLabel').textContent = loanState.rate.toFixed(2) + '%';
  document.getElementById('tenureLabel').textContent = loanState.tenure + ' yr';
}

function renderCalculator() {
  loanState.amount = Number(amountSlider.value);
  loanState.rate = Number(rateSlider.value);
  loanState.tenure = Number(tenureSlider.value);
  loanState.loanType = loanTypeSelect.value;
  updateCalculatorLabels();

  const { emi, monthly } = buildAmortizationSchedule(loanState.amount, loanState.rate, loanState.tenure);
  const totalPayment = monthly.reduce((s, m) => s + m.principalPaid + m.interest, 0);
  const totalInterest = totalPayment - loanState.amount;

  loanState.emi = emi;
  loanState.totalInterest = totalInterest;

  document.getElementById('emiAmount').textContent = formatINR(emi);
  document.getElementById('metaPrincipal').textContent = formatINR(loanState.amount);
  document.getElementById('metaInterest').textContent = formatINR(totalInterest);
  document.getElementById('metaTotal').textContent = formatINR(totalPayment);

  const years = yearlyFromMonthly(monthly);
  renderAmortTable(years);
  renderDoughnut(loanState.amount, totalInterest);
  renderStackedBar(years);
  updateContextPill();
}

function renderAmortTable(years) {
  const body = document.getElementById('amortBody');
  body.innerHTML = years.map((y) => `
    <tr>
      <td>${y.year}</td>
      <td>${formatINR(y.principalPaid)}</td>
      <td>${formatINR(y.interestPaid)}</td>
      <td>${formatINR(y.totalPaid)}</td>
      <td>${formatINR(y.closingBalance)}</td>
    </tr>
  `).join('');
}

function chartTextColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e9eaf0';
}

function renderDoughnut(principal, interest) {
  const ctx = document.getElementById('doughnutChart');
  const data = {
    labels: ['Principal', 'Total Interest'],
    datasets: [{ data: [principal, interest], backgroundColor: ['#7c6ef5', '#ff6b6b'], borderWidth: 0 }],
  };
  if (doughnutChart) {
    doughnutChart.data = data;
    doughnutChart.options.plugins.legend.labels.color = chartTextColor();
    doughnutChart.update();
  } else {
    doughnutChart = new Chart(ctx, {
      type: 'doughnut',
      data,
      options: { plugins: { legend: { position: 'bottom', labels: { color: chartTextColor() } } }, cutout: '68%' },
    });
  }
}

function renderStackedBar(years) {
  const ctx = document.getElementById('stackedBarChart');
  const data = {
    labels: years.map((y) => 'Y' + y.year),
    datasets: [
      { label: 'Principal', data: years.map((y) => Math.round(y.principalPaid)), backgroundColor: '#7c6ef5' },
      { label: 'Interest', data: years.map((y) => Math.round(y.interestPaid)), backgroundColor: '#ff6b6b' },
    ],
  };
  const color = chartTextColor();
  const scaleOpts = {
    x: { stacked: true, ticks: { color }, grid: { display: false } },
    y: { stacked: true, ticks: { color }, grid: { color: 'rgba(128,128,128,0.15)' } },
  };
  if (stackedBarChart) {
    stackedBarChart.data = data;
    stackedBarChart.options.scales = scaleOpts;
    stackedBarChart.options.plugins.legend.labels.color = color;
    stackedBarChart.update();
  } else {
    stackedBarChart = new Chart(ctx, {
      type: 'bar',
      data,
      options: { plugins: { legend: { position: 'bottom', labels: { color } } }, scales: scaleOpts },
    });
  }
}

[amountSlider, rateSlider, tenureSlider, loanTypeSelect].forEach((el) => {
  el.addEventListener('input', renderCalculator);
});

// Shareable link: encodes the current loan into the URL so pasting it
// elsewhere (or bookmarking it) reopens the calculator pre-filled.
function buildShareURL() {
  const params = new URLSearchParams({
    amt: loanState.amount,
    rate: loanState.rate,
    yrs: loanState.tenure,
    type: loanState.loanType,
    mode: loanMode,
  });
  return window.location.origin + window.location.pathname + '?' + params.toString();
}

async function copyShareLink() {
  const url = buildShareURL();
  try {
    await navigator.clipboard.writeText(url);
    showAlert('Link copied! Paste it anywhere to share this exact loan scenario.', 'warning');
  } catch (e) {
    showAlert('Could not copy automatically — copy this link: ' + url);
  }
}

function loadStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('amt')) return;

  const amount = clampTo(Number(params.get('amt')) || loanState.amount, 100000, 10000000);
  const rate = clampTo(Number(params.get('rate')) || loanState.rate, 5, 20);
  const tenure = clampTo(Number(params.get('yrs')) || loanState.tenure, 1, 30);
  const type = params.get('type') === 'fixed' ? 'fixed' : 'floating';
  const mode = params.get('mode') === 'existing' ? 'existing' : 'new';

  amountSlider.value = amount;
  rateSlider.value = rate;
  tenureSlider.value = tenure;
  loanTypeSelect.value = type;
  renderCalculator();
  applyLoanMode(mode);
}

document.getElementById('shareLinkBtn').addEventListener('click', copyShareLink);
document.getElementById('printSummaryBtn').addEventListener('click', () => window.print());

// ============================================================
// Tab 2: Early Closure Planner
// ============================================================
let activeStrategyTab = 'lumpSumOnly';

function getPlannerInputs() {
  return {
    lumpSum: Number(document.getElementById('lumpSum').value) || 0,
    extraMonthly: Number(document.getElementById('extraMonthly').value) || 0,
    annualLumpSum: Number(document.getElementById('annualLumpSum').value) || 0,
    annualHike: Number(document.getElementById('annualHike').value) || 0,
    prepayMonth: Number(document.getElementById('prepayMonth').value) || 1,
  };
}

function applyStrategyTab(strategy) {
  activeStrategyTab = strategy;
  document.querySelectorAll('.strategy-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.strategy === strategy);
  });
  document.querySelectorAll('.planner-inputs .field[data-for]').forEach((field) => {
    const shows = field.dataset.for.split(' ').includes(strategy);
    field.style.display = shows ? '' : 'none';
  });
  renderPlanner();
}

document.getElementById('strategyTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.strategy-tab');
  if (tab) applyStrategyTab(tab.dataset.strategy);
});

function renderPlanner() {
  const { amount, rate, tenure } = loanState;
  const { lumpSum, extraMonthly, annualLumpSum, annualHike, prepayMonth } = getPlannerInputs();

  const amountField = document.getElementById('plannerAmount');
  const rateField = document.getElementById('plannerRate');
  const tenureField = document.getElementById('plannerTenure');
  if (document.activeElement !== amountField) amountField.value = amount;
  if (document.activeElement !== rateField) rateField.value = rate;
  if (document.activeElement !== tenureField) tenureField.value = tenure;

  const plannerPill = document.getElementById('plannerContextPill');
  if (plannerPill) {
    plannerPill.textContent = `● Calculating for: ${formatINR(amount)} · ${rate.toFixed(2)}% · ${tenure}yr · EMI ${formatINR(loanState.emi)}`;
  }

  const base = simulateWithPrepayment(amount, rate, tenure, {});
  const strategies = {
    lumpSumOnly: simulateWithPrepayment(amount, rate, tenure, { lumpSum, lumpSumMonth: prepayMonth }),
    extraMonthlyOnly: simulateWithPrepayment(amount, rate, tenure, { extraMonthly }),
    annualLumpSumOnly: simulateWithPrepayment(amount, rate, tenure, { annualLumpSum }),
    annualHikeOnly: simulateWithPrepayment(amount, rate, tenure, { annualHikePercent: annualHike }),
    combined: simulateWithPrepayment(amount, rate, tenure, { lumpSum, lumpSumMonth: prepayMonth, extraMonthly, annualLumpSum, annualHikePercent: annualHike }),
  };

  const labels = {
    lumpSumOnly: 'One-time payment',
    extraMonthlyOnly: 'Extra every month',
    annualLumpSumOnly: 'Extra every year',
    annualHikeOnly: 'Step-up EMI',
    combined: 'Combined strategy',
  };

  let bestKey = null, bestSaved = -Infinity;
  for (const key of Object.keys(strategies)) {
    const saved = base.totalInterest - strategies[key].totalInterest;
    if (saved > bestSaved) { bestSaved = saved; bestKey = key; }
  }

  const grid = document.getElementById('strategyGrid');
  grid.innerHTML = Object.keys(strategies).map((key) => {
    const s = strategies[key];
    const saved = base.totalInterest - s.totalInterest;
    const monthsSaved = base.months - s.months;
    const closeYear = new Date().getFullYear() + Math.ceil(s.months / 12);
    const isBest = key === bestKey;
    const isFocused = key === activeStrategyTab;
    return `
      <div class="strategy-card ${isBest ? 'best' : ''} ${isFocused ? 'focused' : ''}">
        ${isBest ? '<div class="best-badge">BEST SAVING</div>' : ''}
        <h5>${labels[key]}</h5>
        <div class="strategy-stat saved"><span>Interest saved</span><span class="v mono">${formatINR(saved)}</span></div>
        <div class="strategy-stat"><span>New close year</span><span class="v mono">${closeYear}</span></div>
        <div class="strategy-stat"><span>Months saved</span><span class="v mono">${Math.max(0, monthsSaved)}</span></div>
      </div>
    `;
  }).join('');

  const maxSaved = Math.max(1, ...Object.keys(strategies).map((k) => base.totalInterest - strategies[k].totalInterest));
  document.getElementById('compareBarsWrap').innerHTML = Object.keys(strategies).map((key) => {
    const saved = base.totalInterest - strategies[key].totalInterest;
    const pct = Math.max(2, (saved / maxSaved) * 100);
    return `
      <div class="bar-row">
        <div class="bar-label">${labels[key]}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-value mono">${formatINR(saved)}</div>
      </div>
    `;
  }).join('');

  renderBalanceChart(base, strategies, labels);
}

function renderBalanceChart(base, strategies, labels) {
  const ctx = document.getElementById('balanceChart');
  const maxLen = Math.max(base.monthly.length, ...Object.values(strategies).map((s) => s.monthly.length));
  const xLabels = Array.from({ length: Math.ceil(maxLen / 12) }, (_, i) => 'Y' + (i + 1));

  function yearlyBalances(monthly) {
    const out = [];
    for (let i = 11; i < monthly.length; i += 12) out.push(Math.round(monthly[i].balance));
    if (monthly.length % 12 !== 0) out.push(Math.round(monthly[monthly.length - 1].balance));
    return out;
  }

  const colors = { base: '#9aa0b4', lumpSumOnly: '#7c6ef5', extraMonthlyOnly: '#4ade80', annualHikeOnly: '#fbbf24', combined: '#ff6b6b' };
  const datasets = [{ label: 'Base (no prepayment)', data: yearlyBalances(base.monthly), borderColor: colors.base, backgroundColor: 'transparent', tension: 0.3 }];
  Object.keys(strategies).forEach((key) => {
    datasets.push({ label: labels[key], data: yearlyBalances(strategies[key].monthly), borderColor: colors[key], backgroundColor: 'transparent', tension: 0.3 });
  });

  const color = chartTextColor();
  const data = { labels: xLabels, datasets };
  const scales = {
    x: { ticks: { color }, grid: { display: false } },
    y: { ticks: { color }, grid: { color: 'rgba(128,128,128,0.15)' } },
  };

  if (balanceChart) {
    balanceChart.data = data;
    balanceChart.options.scales = scales;
    balanceChart.options.plugins.legend.labels.color = color;
    balanceChart.update();
  } else {
    balanceChart = new Chart(ctx, {
      type: 'line',
      data,
      options: { plugins: { legend: { position: 'bottom', labels: { color } } }, scales, elements: { point: { radius: 0 } } },
    });
  }
}

['lumpSum', 'extraMonthly', 'annualHike', 'prepayMonth'].forEach((id) => {
  document.getElementById(id).addEventListener('input', renderPlanner);
});

function clampTo(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Editing the loan amount/rate/tenure here updates the same shared loan state
// as the EMI Calculator tab's sliders (and the AI Chat context), so the whole
// app stays in sync regardless of which tab you edit from. Synced on 'change'
// (blur/Enter), not 'input', so clamping doesn't interrupt mid-typing.
document.getElementById('plannerAmount').addEventListener('change', (e) => {
  amountSlider.value = clampTo(Number(e.target.value) || loanState.amount, 100000, 10000000);
  renderCalculator();
  renderPlanner();
});
document.getElementById('plannerRate').addEventListener('change', (e) => {
  rateSlider.value = clampTo(Number(e.target.value) || loanState.rate, 5, 20);
  renderCalculator();
  renderPlanner();
});
document.getElementById('plannerTenure').addEventListener('change', (e) => {
  tenureSlider.value = clampTo(Number(e.target.value) || loanState.tenure, 1, 30);
  renderCalculator();
  renderPlanner();
});

// ============================================================
// Tab: Compare Loans
// ============================================================
const COMPARE_COLORS = ['#7c6ef5', '#4ade80', '#fbbf24'];
let compareLoans = [
  { amount: 2500000, rate: 9.5, tenure: 20 },
  { amount: 2500000, rate: 8.5, tenure: 20 },
];
let compareChart;

function renderCompareCards() {
  const wrap = document.getElementById('compareLoanCards');
  wrap.innerHTML = compareLoans.map((loan, i) => `
    <div class="compare-card" data-index="${i}">
      <div class="compare-card-header">
        <h3><span class="compare-swatch" style="background:${COMPARE_COLORS[i]}"></span>Loan ${String.fromCharCode(65 + i)}</h3>
        ${compareLoans.length > 2 ? `<button class="compare-remove-btn" data-remove="${i}">Remove</button>` : ''}
      </div>
      <div class="compare-field"><label>Loan amount (₹)</label><input type="number" class="compare-amount" data-index="${i}" value="${loan.amount}" min="100000" max="100000000" step="10000"></div>
      <div class="compare-field"><label>Interest rate (%)</label><input type="number" class="compare-rate" data-index="${i}" value="${loan.rate}" min="1" max="30" step="0.05"></div>
      <div class="compare-field"><label>Tenure (years)</label><input type="number" class="compare-tenure" data-index="${i}" value="${loan.tenure}" min="1" max="30" step="1"></div>
    </div>
  `).join('');

  wrap.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.index);
      const val = Number(e.target.value) || 0;
      if (e.target.classList.contains('compare-amount')) compareLoans[i].amount = Math.max(100000, Math.min(100000000, val));
      if (e.target.classList.contains('compare-rate')) compareLoans[i].rate = Math.max(1, Math.min(30, val));
      if (e.target.classList.contains('compare-tenure')) compareLoans[i].tenure = Math.max(1, Math.min(30, val));
      e.target.value = e.target.classList.contains('compare-amount') ? compareLoans[i].amount
        : e.target.classList.contains('compare-rate') ? compareLoans[i].rate : compareLoans[i].tenure;
      renderCompareResults();
    });
  });

  wrap.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = Number(e.target.dataset.remove);
      compareLoans.splice(i, 1);
      document.getElementById('addCompareLoanBtn').style.display = '';
      renderCompareCards();
      renderCompareResults();
    });
  });
}

function renderCompareResults() {
  const results = compareLoans.map((loan) => {
    const emi = computeEMI(loan.amount, loan.rate, loan.tenure);
    const totalPayment = emi * loan.tenure * 12;
    const totalInterest = totalPayment - loan.amount;
    return { emi, totalInterest, totalPayment };
  });

  const cheapestIdx = compareLoans.length > 1
    ? results.reduce((best, r, i) => (r.totalInterest < results[best].totalInterest ? i : best), 0)
    : -1;

  document.querySelectorAll('.compare-card').forEach((card, i) => {
    card.classList.toggle('cheapest', i === cheapestIdx);
  });

  const tbody = document.getElementById('compareTableBody');
  tbody.innerHTML = results.map((r, i) => `
    <tr>
      <td><span class="compare-swatch" style="background:${COMPARE_COLORS[i]}"></span> Loan ${String.fromCharCode(65 + i)}</td>
      <td class="${i === cheapestIdx ? 'cheapest-cell' : ''}">${formatINR(r.emi)}</td>
      <td class="${i === cheapestIdx ? 'cheapest-cell' : ''}">${formatINR(r.totalInterest)}</td>
      <td>${formatINR(r.totalPayment)}</td>
    </tr>
  `).join('');

  const color = chartTextColor();
  const data = {
    labels: compareLoans.map((_, i) => 'Loan ' + String.fromCharCode(65 + i)),
    datasets: [{ label: 'Total Interest', data: results.map((r) => Math.round(r.totalInterest)), backgroundColor: compareLoans.map((_, i) => COMPARE_COLORS[i]) }],
  };
  const scales = {
    x: { ticks: { color }, grid: { display: false } },
    y: { ticks: { color }, grid: { color: 'rgba(128,128,128,0.15)' } },
  };
  if (compareChart) {
    compareChart.data = data;
    compareChart.options.scales = scales;
    compareChart.options.plugins.legend.labels.color = color;
    compareChart.update();
  } else {
    compareChart = new Chart(document.getElementById('compareChart'), {
      type: 'bar',
      data,
      options: { plugins: { legend: { display: false, labels: { color } } }, scales },
    });
  }
}

document.getElementById('addCompareLoanBtn').addEventListener('click', () => {
  if (compareLoans.length >= 3) return;
  compareLoans.push({ amount: 2500000, rate: 9.5, tenure: 20 });
  renderCompareCards();
  renderCompareResults();
  if (compareLoans.length >= 3) document.getElementById('addCompareLoanBtn').style.display = 'none';
});

// ============================================================
// Tab: Loan Eligibility
// ============================================================
function renderEligibility() {
  const income = Math.max(0, Number(document.getElementById('eligIncome').value) || 0);
  const existingEmi = Math.max(0, Number(document.getElementById('eligExistingEmi').value) || 0);
  const foir = Math.min(65, Math.max(30, Number(document.getElementById('eligFoir').value) || 50));
  const rate = Number(document.getElementById('eligRate').value) || 9.5;
  const tenure = Number(document.getElementById('eligTenure').value) || 20;

  const maxTotalEmi = income * (foir / 100);
  const maxNewEmi = Math.max(0, maxTotalEmi - existingEmi);
  const maxLoan = maxNewEmi > 0 ? maxLoanForEmi(maxNewEmi, rate, tenure) : 0;

  document.getElementById('eligMaxLoan').textContent = formatINR(maxLoan);
  document.getElementById('eligMaxEmi').textContent = formatINR(maxNewEmi);
  document.getElementById('eligFoirUsed').textContent = foir + '%';
  document.getElementById('eligExistingLoad').textContent = formatINR(existingEmi);
}

['eligIncome', 'eligExistingEmi', 'eligFoir', 'eligRate', 'eligTenure'].forEach((id) => {
  document.getElementById(id).addEventListener('input', renderEligibility);
});

// ============================================================
// Tab: SIP vs Prepayment
// ============================================================
function renderSipComparison() {
  const { amount, rate, tenure } = loanState;
  const extraMonthly = Math.max(0, Number(document.getElementById('sipExtraMonthly').value) || 0);
  const sipReturn = Number(document.getElementById('sipReturnRate').value) || 12;

  const pill = document.getElementById('sipContextPill');
  if (pill) pill.textContent = `● Calculating for: ${formatINR(amount)} · ${rate.toFixed(2)}% · ${tenure}yr · EMI ${formatINR(loanState.emi)}`;

  const base = simulateWithPrepayment(amount, rate, tenure, {});
  const withExtra = simulateWithPrepayment(amount, rate, tenure, { extraMonthly });
  const months = withExtra.months;
  const interestSaved = base.totalInterest - withExtra.totalInterest;
  const monthsSaved = base.months - withExtra.months;

  document.getElementById('sipInterestSaved').textContent = formatINR(interestSaved);
  document.getElementById('sipCloseDuration').textContent = formatMonthsAsDuration(months);
  document.getElementById('sipMonthsSaved').textContent = Math.max(0, monthsSaved);

  const corpus = sipFutureValue(extraMonthly, sipReturn, months);
  const totalInvested = extraMonthly * months;
  const gains = corpus - totalInvested;

  document.getElementById('sipCorpus').textContent = formatINR(corpus);
  document.getElementById('sipTotalInvested').textContent = formatINR(totalInvested);
  document.getElementById('sipGains').textContent = formatINR(gains);

  const verdict = document.getElementById('sipVerdict');
  if (corpus > interestSaved) {
    verdict.textContent = `Over the same ${formatMonthsAsDuration(months)}, the SIP's estimated corpus (${formatINR(corpus)}) is larger than the interest you'd save by prepaying (${formatINR(interestSaved)}) — but see the caveat below before deciding.`;
  } else {
    verdict.textContent = `Over the same ${formatMonthsAsDuration(months)}, prepaying saves more (${formatINR(interestSaved)}) than the SIP's estimated corpus (${formatINR(corpus)}) — and prepayment's saving is guaranteed, unlike the SIP's.`;
  }
}

function formatMonthsAsDuration(totalMonths) {
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  if (years === 0) return `${months} month${months === 1 ? '' : 's'}`;
  if (months === 0) return `${years} year${years === 1 ? '' : 's'}`;
  return `${years}y ${months}m`;
}

['sipExtraMonthly', 'sipReturnRate'].forEach((id) => {
  document.getElementById(id).addEventListener('input', renderSipComparison);
});

// ============================================================
// Tab 3: AI Chat
// ============================================================
const sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
let messagesSent = 0;
let cooldownActive = false;

const chatWindow = document.getElementById('chatWindow');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const charCounter = document.getElementById('charCounter');
const cooldownOverlay = document.getElementById('cooldownOverlay');
const pipsEl = document.getElementById('pips');
const langSelect = document.getElementById('langSelect');

const EMPTY_STATE_TEXT = {
  hinglish: 'Apna loan ke baare mein kuch bhi pucho — EMI, prepayment, tax benefits, sab kuch.',
  english: 'Ask anything about your loan — EMI, prepayment, tax benefits, all of it.',
  hindi: 'अपने लोन के बारे में कुछ भी पूछें — EMI, प्रीपेमेंट, टैक्स बेनिफिट, सब कुछ.',
};
const INPUT_PLACEHOLDER_TEXT = {
  hinglish: 'Apna sawaal yaha type karo… (Enter to send, Shift+Enter for new line)',
  english: 'Type your question here… (Enter to send, Shift+Enter for new line)',
  hindi: 'अपना सवाल यहाँ टाइप करें… (भेजने के लिए Enter, नई लाइन के लिए Shift+Enter)',
};

function getSelectedLanguage() {
  return langSelect.value;
}

(function initLanguage() {
  let saved = 'hinglish';
  try { saved = localStorage.getItem('loanniti-lang') || 'hinglish'; } catch (e) {}
  langSelect.value = saved;
  applyLanguageText(saved);
})();

function applyLanguageText(lang) {
  const emptyTextEl = document.getElementById('chatEmptyText');
  if (emptyTextEl) emptyTextEl.textContent = EMPTY_STATE_TEXT[lang] || EMPTY_STATE_TEXT.hinglish;
  chatInput.placeholder = INPUT_PLACEHOLDER_TEXT[lang] || INPUT_PLACEHOLDER_TEXT.hinglish;
}

langSelect.addEventListener('change', () => {
  const lang = getSelectedLanguage();
  try { localStorage.setItem('loanniti-lang', lang); } catch (e) {}
  applyLanguageText(lang);
});

function updateContextPill() {
  const pill = document.getElementById('contextPill');
  pill.textContent = `● ${formatINR(loanState.amount)} · ${loanState.rate.toFixed(2)}% · ${loanState.tenure}yr · EMI ${formatINR(loanState.emi)}`;
}

function renderPips() {
  pipsEl.innerHTML = Array.from({ length: MAX_MESSAGES_PER_SESSION }, (_, i) => {
    const used = i < messagesSent;
    let cls = 'pip';
    if (used) {
      cls += ' used';
      if (messagesSent >= MAX_MESSAGES_PER_SESSION) cls += ' full';
      else if (messagesSent >= 7) cls += ' warn';
    }
    return `<div class="${cls}"></div>`;
  }).join('');
}
renderPips();

function updateCharCounter() {
  const remaining = MAX_INPUT_CHARS - chatInput.value.length;
  charCounter.textContent = remaining + ' characters left';
  charCounter.classList.remove('amber', 'red');
  if (remaining <= 50) charCounter.classList.add('red');
  else if (remaining <= 100) charCounter.classList.add('amber');
}
chatInput.addEventListener('input', updateCharCounter);
updateCharCounter();

function appendMessage(role, content) {
  const empty = document.getElementById('chatEmpty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = content;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return el;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'typing-dots';
  el.id = 'typingIndicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}
function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function checkFrontendInjection(message) {
  return INJECTION_PATTERNS.some((p) => p.test(message));
}

function startCooldown() {
  cooldownActive = true;
  sendBtn.disabled = true;
  let remaining = COOLDOWN_SECONDS;
  cooldownOverlay.textContent = remaining + 's…';
  cooldownOverlay.classList.add('show');
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      cooldownOverlay.classList.remove('show');
      cooldownActive = false;
      sendBtn.disabled = false;
    } else {
      cooldownOverlay.textContent = remaining + 's…';
    }
  }, 1000);
}

async function sendMessage(text) {
  const message = text !== undefined ? text : chatInput.value.trim();
  if (!message) return;

  if (message.length > MAX_INPUT_CHARS) {
    showAlert(`Message too long — max ${MAX_INPUT_CHARS} characters.`);
    return;
  }
  if (messagesSent >= MAX_MESSAGES_PER_SESSION) {
    showAlert('Session message limit reached. Please refresh to start a new session.');
    return;
  }
  if (cooldownActive) {
    showAlert('Please wait for the cooldown before sending another message.', 'warning');
    return;
  }
  if (checkFrontendInjection(message)) {
    showAlert('Your message was blocked for containing disallowed content.');
    return;
  }

  appendMessage('user', message);
  chatInput.value = '';
  updateCharCounter();
  messagesSent += 1;
  renderPips();
  startCooldown();
  showTyping();

  try {
    const res = await fetch(BACKEND_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': sessionId },
      body: JSON.stringify({
        message,
        language: getSelectedLanguage(),
        loanContext: {
          amount: loanState.amount,
          rate: loanState.rate,
          tenure: loanState.tenure,
          loanType: loanState.loanType,
          emi: loanState.emi,
          totalInterest: loanState.totalInterest,
        },
      }),
    });

    const data = await res.json();
    hideTyping();

    if (!res.ok) {
      if (data.blocked) showAlert('Message blocked: disallowed content detected.');
      else if (data.sessionLimitReached) showAlert('Session message limit reached.');
      else if (data.retryAfter) showAlert('Rate limit hit. Please slow down.', 'warning');
      else showAlert(data.error || 'Something went wrong.');
      return;
    }

    if (data.reply) {
      appendMessage('assistant', data.reply);
    } else {
      showAlert('No response from the assistant. Please try again.');
    }
  } catch (err) {
    hideTyping();
    showAlert('Could not reach the server. Please try again.');
  }
}

sendBtn.addEventListener('click', () => sendMessage());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
document.querySelectorAll('.suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.dataset.q));
});

// ============================================================
// Email subscribe
// ============================================================
document.getElementById('subscribeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('subscribeEmail');
  const btn = document.getElementById('subscribeBtn');
  const msg = document.getElementById('subscribeMessage');
  const email = input.value.trim();

  msg.textContent = '';
  msg.className = 'subscribe-message';
  btn.disabled = true;
  btn.textContent = 'Subscribing…';

  try {
    const res = await fetch(BACKEND_URL + '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      msg.textContent = data.error || 'Something went wrong. Please try again.';
      msg.classList.add('error');
    } else if (data.alreadySubscribed) {
      msg.textContent = "You're already subscribed with this email.";
      msg.classList.add('success');
    } else {
      msg.textContent = "Subscribed! You'll hear about new features and guides.";
      msg.classList.add('success');
      input.value = '';
    }
  } catch (err) {
    msg.textContent = 'Could not reach the server. Please try again.';
    msg.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Subscribe';
  }
});

// ============================================================
// Init
// ============================================================
renderCalculator();
updateContextPill();
applyStrategyTab('lumpSumOnly');
applyLoanMode('new');
renderCompareCards();
renderCompareResults();
renderEligibility();
renderSipComparison();
loadStateFromURL();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
