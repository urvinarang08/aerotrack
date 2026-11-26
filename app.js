"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  rows: [], months: [], monthly: new Map(), routes: new Map(), carrierRoutes: new Map(),
  routeKeys: [], airlines: [], demandThresholds: new Map(), fileName: "", page: "dashboard", sortBy: "passengers",
  sortDirection: -1, explorerPage: 0, pageSize: 18, quality: null, columnAudit: [], encodingField: "airline", featureMethod: "f_test", journeyRoute: "all", journeyModel: "seasonal"
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const moneyless = (value) => compact.format(Number.isFinite(value) ? value : 0);
const DATA_DB_NAME = "airtrack-local-storage";
const DATA_STORE_NAME = "datasets";
const SAVED_DATASET_KEY = "last-imported-csv";
const monthText = (key) => {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
};
const monthYear = (key) => {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};
const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;
const shiftMonth = (key, amount) => {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
};
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

function parseCSVLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { values.push(value); value = ""; }
    else value += char;
  }
  values.push(value);
  return values;
}

function getMonthFromRow(cells, indices) {
  if (indices.year >= 0 && indices.month >= 0) {
    const y = Number(cells[indices.year]);
    const m = Number(cells[indices.month]);
    return Number.isInteger(y) && m >= 1 && m <= 12 ? monthKey(y, m) : "";
  }
  const raw = String(cells[indices.date] ?? "").trim();
  const compactDate = raw.match(/^(\d{4})(\d{2})$/);
  if (compactDate) return monthKey(Number(compactDate[1]), Number(compactDate[2]));
  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) return monthKey(Number(yearOnly[1]), 1);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : monthKey(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
}

function addToMap(map, key, month, passengers) {
  let item = map.get(key);
  if (!item) {
    item = { total: 0, monthly: new Map() };
    map.set(key, item);
  }
  item.total += passengers;
  item.monthly.set(month, (item.monthly.get(month) || 0) + passengers);
  return item;
}

async function parsePassengerCSV(text, fileName) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const rawHeaders = parseCSVLine(lines[0] || "").map((h) => h.trim());
  const headers = rawHeaders.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const columnStats = rawHeaders.map((name) => ({ name, missing: 0, numeric: 0, text: 0, count: 0, sum: 0, min: Infinity, max: -Infinity, uniques: new Set() }));
  const find = (...names) => {
    for (const name of names) {
      const index = headers.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const indices = {
    year: find("year"), month: find("month"), date: find("date", "yearmonth", "period"),
    origin: find("origin", "origincode"), destination: find("dest", "destination", "destinationcode"),
    passengers: find("passengers", "pax"), airline: find("uniquecarriername", "airline", "carriername", "uniquecarrier", "carrier"),
    distance: find("distance")
  };
  if ((indices.year < 0 || indices.month < 0) && indices.date < 0) throw new Error("CSV needs YEAR and MONTH columns, or a DATE column.");
  if (indices.origin < 0 || indices.destination < 0 || indices.passengers < 0) throw new Error("CSV needs ORIGIN, DEST, and PASSENGERS columns.");

  const rows = [];
  const monthly = new Map();
  const routes = new Map();
  const carrierRoutes = new Map();
  const airlines = new Set();
  let firstMonth = "9999-99";
  let lastMonth = "0000-00";
  let accepted = 0;
  let sourceRows = 0, invalidRows = 0, repeatedMonthlyKeys = 0, zeroPassengerRows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    sourceRows++;
    const cells = parseCSVLine(line);
    for (let j = 0; j < columnStats.length; j++) {
      const stat = columnStats[j];
      const value = String(cells[j] ?? "").trim();
      const isCodeField = /^(unique_carrier|unique_carrier_name|origin|dest)$/i.test(stat.name);
      if (!value || (!isCodeField && /^(na|n\/a|null|nan)$/i.test(value))) { stat.missing++; continue; }
      stat.count++;
      if (stat.uniques.size < 10000) stat.uniques.add(value);
      const numeric = Number(value.replaceAll(",", ""));
      if (Number.isFinite(numeric)) { stat.numeric++; stat.sum += numeric; stat.min = Math.min(stat.min, numeric); stat.max = Math.max(stat.max, numeric); }
      else stat.text++;
    }
    const month = getMonthFromRow(cells, indices);
    const origin = String(cells[indices.origin] ?? "").trim().toUpperCase();
    const destination = String(cells[indices.destination] ?? "").trim().toUpperCase();
    const passengers = Number(String(cells[indices.passengers] ?? "").replaceAll(",", ""));
    if (!month || !origin || !destination || !Number.isFinite(passengers) || passengers < 0) { invalidRows++; continue; }
    const airline = String(indices.airline >= 0 ? cells[indices.airline] : "All carriers").trim() || "All carriers";
    const distance = indices.distance >= 0 ? Number(cells[indices.distance]) || 0 : 0;
    const route = `${origin}|${destination}`;
    const existingCarrierRoute = carrierRoutes.get(`${route}\u001f${airline}`);
    if (existingCarrierRoute?.monthly.has(month)) repeatedMonthlyKeys++;
    if (passengers === 0) zeroPassengerRows++;
    const carrierRoute = `${route}\u001f${airline}`;
    const record = { month, origin, destination, airline, route, passengers, distance };
    rows.push(record);
    monthly.set(month, (monthly.get(month) || 0) + passengers);
    const routeItem = addToMap(routes, route, month, passengers);
    routeItem.origin = origin;
    routeItem.destination = destination;
    addToMap(carrierRoutes, carrierRoute, month, passengers);
    carrierRoutes.get(carrierRoute).route = route;
    carrierRoutes.get(carrierRoute).airline = airline;
    airlines.add(airline);
    if (month < firstMonth) firstMonth = month;
    if (month > lastMonth) lastMonth = month;
    accepted++;
    if (accepted % 25000 === 0) {
      setNotice(`Reading ${fileName}: ${number.format(accepted)} records…`, "success");
      await pause();
    }
  }
  if (!rows.length) throw new Error("No usable passenger rows were found in this CSV.");
  const months = [];
  for (let key = firstMonth; key <= lastMonth; key = shiftMonth(key, 1)) months.push(key);
  const columnAudit = columnStats.map((stat) => ({
    name: stat.name, inferredType: /date|period|year.?month/i.test(stat.name) ? "Date/time" : (stat.count > 0 && stat.text === 0 ? "Numeric" : "Categorical / text"),
    missing: stat.missing, missingPct: sourceRows ? 100 * stat.missing / sourceRows : 0,
    unique: stat.uniques.size, mean: stat.numeric ? stat.sum / stat.numeric : null,
    min: stat.numeric ? stat.min : null, max: stat.numeric ? stat.max : null
  }));
  return { rows, monthly, routes, carrierRoutes, airlines: [...airlines].sort(), months, fileName, columnAudit, quality: { sourceRows, invalidRows, repeatedMonthlyKeys, zeroPassengerRows } };
}

function setNotice(message, type = "success") {
  const notice = $("notice");
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}
function hideNotice() { const notice = $("notice"); notice.hidden = true; }
let toastTimer;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), 2600);
}

function visibleMonths(period) {
  if (!state.months.length) return [];
  return period === "all" ? state.months : state.months.slice(-Number(period));
}
function routeMonthly(routeKey) {
  return routeKey === "all" ? state.monthly : (state.routes.get(routeKey)?.monthly || new Map());
}
function valuesFor(months, series) { return months.map((month) => series.get(month) || 0); }
function routeLabel(routeKey) { return routeKey === "all" ? "All routes" : routeKey.split("|").join(" → "); }
function signedChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}
function changeMarkup(value) {
  if (value === null || !Number.isFinite(value)) return '<span class="change-flat">—</span>';
  const cls = value > .15 ? "change-up" : value < -.15 ? "change-down" : "change-flat";
  const arrow = value > .15 ? "↑" : value < -.15 ? "↓" : "·";
  return `<span class="${cls}">${arrow} ${Math.abs(value).toFixed(1)}%</span>`;
}
function getDemandThreshold(month) {
  if (state.demandThresholds.has(month)) return state.demandThresholds.get(month);
  const values = [];
  for (const item of state.carrierRoutes.values()) {
    const value = item.monthly.get(month) || 0;
    if (value > 0) values.push(value);
  }
  if (!values.length) return Infinity;
  values.sort((a, b) => a - b);
  const threshold = values[Math.floor((values.length - 1) * .75)];
  state.demandThresholds.set(month, threshold);
  return threshold;
}
function demandMarkup(value, threshold) {
  return value >= threshold ? '<span class="demand-tag">HIGH</span>' : '<span class="demand-tag normal">NORMAL</span>';
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col] || 1e-9;
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}
function fitPolynomial(values, degree) {
  const size = degree + 1;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const vector = Array(size).fill(0);
  values.forEach((value, x) => {
    const powers = Array(size).fill(1);
    for (let p = 1; p < size; p++) powers[p] = powers[p - 1] * x;
    for (let a = 0; a < size; a++) {
      vector[a] += powers[a] * value;
      for (let b = 0; b < size; b++) matrix[a][b] += powers[a] * powers[b];
    }
  });
  for (let i = 0; i < size; i++) matrix[i][i] += 1e-8;
  const coefficients = solveLinearSystem(matrix, vector);
  return (x) => coefficients.reduce((sum, coefficient, power) => sum + coefficient * (x ** power), 0);
}
function evaluateForecast(series) {
  const years = [...new Set(state.months.map((month) => Number(month.slice(0, 4))))].sort((a, b) => a - b);
  const testYear = years.at(-1);
  const trainYear = years.slice(0, -1).reverse().find((year) => state.months.filter((m) => m.startsWith(`${year}-`)).length === 12);
  if (!trainYear || !testYear || testYear === trainYear) return null;
  const trainMonths = Array.from({ length: 12 }, (_, i) => monthKey(trainYear, i + 1));
  const testMonths = state.months.filter((m) => m.startsWith(`${testYear}-`));
  const trainValues = valuesFor(trainMonths, series);
  const persistence = trainValues.at(-1) || 0;
  const linear = fitPolynomial(trainValues, 1);
  const polynomial = fitPolynomial(trainValues, 2);
  const rows = [];
  for (const testMonth of testMonths) {
    const [year, month] = testMonth.split("-").map(Number);
    const actual = series.get(testMonth) || 0;
    rows.push({
      month: testMonth,
      actual,
      seasonal: series.get(monthKey(year - 1, month)) || 0,
      persistence,
      linear: Math.max(0, linear(11 + month)),
      polynomial: Math.max(0, polynomial(11 + month))
    });
  }
  if (!rows.length) return null;
  const mae = (key) => rows.reduce((sum, row) => sum + Math.abs(row.actual - row[key]), 0) / rows.length;
  return { trainYear, testYear, rows, seasonal: mae("seasonal"), persistence: mae("persistence"), linear: mae("linear"), polynomial: mae("polynomial") };
}
function futureForecast(series, historyMonths, horizon = 6) {
  if (!historyMonths.length) return [];
  const result = [];
  const last = historyMonths.at(-1);
  for (let i = 1; i <= horizon; i++) {
    const target = shiftMonth(last, i);
    const [year, month] = target.split("-").map(Number);
    const seasonalKey = monthKey(year - 1, month);
    const seasonalValue = series.get(seasonalKey);
    const fallbackValues = historyMonths.slice(-3).map((key) => series.get(key) || 0);
    const fallback = fallbackValues.length ? fallbackValues.reduce((a, b) => a + b, 0) / fallbackValues.length : 0;
    result.push({ month: target, value: seasonalValue ?? fallback, basis: seasonalValue === undefined ? "recent average" : `same month in ${year - 1}` });
  }
  return result;
}

function drawChart(target, months, lines, ariaLabel) {
  if (!months.length) { target.innerHTML = '<div class="chart-placeholder">No monthly values are available for this selection.</div>'; return; }
  const width = 820, height = 258, left = 55, right = 15, top = 17, bottom = 34;
  const numeric = lines.flatMap((line) => line.values.filter((v) => Number.isFinite(v)));
  const max = Math.max(1, ...numeric) * 1.12;
  const x = (index) => left + ((width - left - right) * index / Math.max(1, months.length - 1));
  const y = (value) => top + ((height - top - bottom) * (1 - value / max));
  let grid = "";
  for (let i = 1; i <= 4; i++) {
    const value = max * i / 4;
    const yy = y(value);
    grid += `<line class="chart-grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text class="chart-axis" x="${left - 8}" y="${yy + 3}" text-anchor="end">${esc(moneyless(value))}</text>`;
  }
  const tickStep = Math.max(1, Math.ceil(months.length / 6));
  let ticks = "";
  months.forEach((month, index) => {
    if (index % tickStep === 0 || index === months.length - 1) ticks += `<text class="chart-axis" x="${x(index)}" y="${height - 5}" text-anchor="middle">${esc(monthText(month))}</text>`;
  });
  let linesSvg = "";
  for (const line of lines) {
    const points = line.values.map((value, index) => Number.isFinite(value) ? `${x(index)},${y(value)}` : "").filter(Boolean).join(" ");
    if (!points) continue;
    linesSvg += `<polyline class="${line.className}" points="${points}"/>`;
    if (line.points) {
      line.values.forEach((value, index) => {
        if (Number.isFinite(value)) linesSvg += `<circle class="chart-point ${line.pointClass || ""}" cx="${x(index)}" cy="${y(value)}" r="3"><title>${esc(monthYear(months[index]))}: ${number.format(value)}</title></circle>`;
      });
    }
  }
  target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${esc(ariaLabel)}"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#67aa9a"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>${grid}${ticks}${linesSvg}</svg>`;
}

function setPage(page) {
  state.page = page;
  const hasData = state.rows.length > 0;
  const titles = { dashboard: "Overview", explorer: "Route explorer", forecast: "Forecast lab", journey: "ML journey", data: "Data & methods" };
  $("breadcrumbCurrent").textContent = titles[page] || "Overview";
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    const active = panel.dataset.pagePanel === page;
    panel.hidden = !active || (!hasData && !["data", "journey", "forecast", "explorer"].includes(page));
    panel.classList.toggle("active", active);
  });
  $("emptyState").hidden = hasData || page !== "dashboard";
  if (page === "dashboard" && hasData) renderDashboard();
  if (page === "explorer" && hasData) renderExplorer();
  if (page === "forecast" && hasData) renderForecastPage();
  if (page === "journey") renderJourney();
  if (page === "data") renderDataPage();
}

function populateFilters() {
  const routeOptions = ['<option value="all">All routes</option>'];
  for (const key of state.routeKeys) routeOptions.push(`<option value="${esc(key)}">${esc(routeLabel(key))}</option>`);
  for (const id of ["routeFilter", "forecastRoute"]) {
    const select = $(id);
    const old = select.value;
    select.innerHTML = routeOptions.join("");
    if (old && [...select.options].some((option) => option.value === old)) select.value = old;
  }
  const airlineSelect = $("airlineFilter");
  const oldAirline = airlineSelect.value;
  airlineSelect.innerHTML = '<option value="all">All airlines</option>' + state.airlines.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  if (oldAirline && [...airlineSelect.options].some((option) => option.value === oldAirline)) airlineSelect.value = oldAirline;
}

function populateDataStatus() {
  const first = state.months[0], last = state.months.at(-1);
  const period = first && last ? `${monthText(first)} – ${monthText(last)}` : "—";
  $("sidebarDataStatus").textContent = `${number.format(state.rows.length)} records loaded`;
  $("sidebarPeriod").textContent = `${state.fileName || "BTS data"} · ${period}`;
  $("topDataStatus").textContent = last ? `Latest month ${monthText(last)} · BTS` : "No dataset loaded";
  $("ribbonPeriod").textContent = period;
  $("dataRibbonText").textContent = `BTS monthly reporting · ${number.format(state.rows.length)} carrier-route-month records · data is not live.`;
  $("statusLight").classList.toggle("ready", Boolean(last));
  $("topStatusLight").classList.toggle("ready", Boolean(last));
  $("exportButton").disabled = !state.rows.length;
  $("deleteDataButton").disabled = !state.rows.length;
  document.body.classList.toggle("has-data", Boolean(state.rows.length));
}

function makeCarrierRows(months, routeFilter = "all", airlineFilter = "all", search = "") {
  const latest = state.months.at(-1);
  const previous = latest ? shiftMonth(latest, -1) : "";
  const threshold = latest ? getDemandThreshold(latest) : Infinity;
  const needle = search.trim().toLowerCase();
  const output = [];
  for (const item of state.carrierRoutes.values()) {
    if (routeFilter !== "all" && item.route !== routeFilter) continue;
    if (airlineFilter !== "all" && item.airline !== airlineFilter) continue;
    const routeName = routeLabel(item.route);
    if (needle && !`${routeName} ${item.airline}`.toLowerCase().includes(needle)) continue;
    let total = 0;
    for (const month of months) total += item.monthly.get(month) || 0;
    if (!total && !months.some((month) => item.monthly.has(month))) continue;
    const current = item.monthly.get(latest) || 0;
    const prior = item.monthly.get(previous) || 0;
    output.push({
      route: item.route, routeName, airline: item.airline, passengers: total,
      change: signedChange(current, prior), latest: current, high: current >= threshold
    });
  }
  output.sort((a, b) => {
    let comparison = 0;
    if (state.sortBy === "route") comparison = a.routeName.localeCompare(b.routeName);
    else if (state.sortBy === "airline") comparison = a.airline.localeCompare(b.airline);
    else comparison = a.passengers - b.passengers;
    return comparison * state.sortDirection;
  });
  return output;
}

function rowHTML(item) {
  return `<tr><td><button class="route-cell-button" type="button" data-open-route="${esc(item.route)}">${esc(item.routeName)}</button></td><td class="airline-cell" title="${esc(item.airline)}">${esc(item.airline)}</td><td class="passenger-cell">${number.format(item.passengers)}</td><td>${changeMarkup(item.change)}</td><td>${demandMarkup(item.latest, getDemandThreshold(state.months.at(-1)))}</td></tr>`;
}
function windowFrom(id) { return visibleMonths($(id).value); }

function renderDashboard() {
  if (!state.rows.length) return;
  const months = windowFrom("periodFilter");
  const route = $("routeFilter").value;
  const series = routeMonthly(route);
  const values = valuesFor(months, series);
  const total = values.reduce((a, b) => a + b, 0);
  const average = months.length ? total / months.length : 0;
  const latest = months.at(-1), previous = months.at(-2);
  const recentChange = latest && previous ? signedChange(series.get(latest) || 0, series.get(previous) || 0) : null;
  const routeTotals = [];
  for (const [key, item] of state.routes) {
    if (route !== "all" && route !== key) continue;
    const routeTotal = months.reduce((sum, month) => sum + (item.monthly.get(month) || 0), 0);
    if (routeTotal > 0) routeTotals.push({ key, total: routeTotal });
  }
  routeTotals.sort((a, b) => b.total - a.total);
  const busiest = routeTotals[0];
  const forecast = futureForecast(series, state.months, 3);
  const forecastValue = forecast[0]?.value || 0;

  $("metricTotal").textContent = moneyless(total);
  $("metricTotalFoot").textContent = `${number.format(months.length)} selected months`;
  $("metricAverage").textContent = moneyless(average);
  $("metricAverageFoot").textContent = `Per month · ${route === "all" ? "all routes" : routeLabel(route)}`;
  $("metricBusiest").textContent = busiest ? routeLabel(busiest.key) : "—";
  $("metricBusiestFoot").textContent = busiest ? `${moneyless(busiest.total)} passenger records in window · click to explore` : "No route records in this window";
  $("metricForecast").textContent = moneyless(forecastValue);
  $("chartSubtitle").textContent = `${route === "all" ? "All routes" : routeLabel(route)} · ${months.length ? `${monthText(months[0])} – ${monthText(months.at(-1))}` : "no months"}`;
  const chartMonths = [...months, ...forecast.map((entry) => entry.month)];
  const actualLine = [...values, ...forecast.map(() => NaN)];
  const predictedLine = Array(Math.max(0, values.length - 1)).fill(NaN);
  if (values.length) predictedLine.push(values.at(-1));
  predictedLine.push(...forecast.map((entry) => entry.value));
  drawChart($("trafficChart"), chartMonths, [
    { values: actualLine, className: "chart-line", points: true },
    { values: predictedLine, className: "chart-forecast", pointClass: "forecast-point" }
  ], "Monthly passenger records and seasonal estimates");

  const topRoutes = routeTotals.slice(0, 6);
  const maxRoute = Math.max(1, topRoutes[0]?.total || 1);
  $("topRoutes").innerHTML = topRoutes.length ? `<div class="route-stack">${topRoutes.map((item, index) => `<button class="route-rank" type="button" data-open-route="${esc(item.key)}"><span class="route-rank-number">${String(index + 1).padStart(2, "0")}</span><span class="route-rank-main"><span class="route-rank-name">${esc(routeLabel(item.key))}</span><span class="route-rank-bar"><i style="width:${Math.max(4, item.total / maxRoute * 100)}%"></i></span></span><span class="route-rank-value">${moneyless(item.total)}</span></button>`).join("")}</div>` : '<div class="chart-placeholder">No routes match this view.</div>';

  const movementText = recentChange === null ? "Not enough months to compare." : `${recentChange >= 0 ? "Up" : "Down"} ${Math.abs(recentChange).toFixed(1)}% from ${monthText(previous)} to ${monthText(latest)}.`;
  $("insightMovement").textContent = movementText;
  const threshold = latest ? getDemandThreshold(latest) : Infinity;
  let highRoutes = 0;
  for (const item of state.carrierRoutes.values()) if ((item.monthly.get(latest) || 0) >= threshold && (item.monthly.get(latest) || 0) > 0) highRoutes++;
  $("insightDemand").textContent = Number.isFinite(threshold) ? `${number.format(highRoutes)} route-airline records are in the top demand quartile for ${monthText(latest)} (>${number.format(threshold)} passengers).` : "No demand threshold is available.";
  const evaluation = evaluateForecast(series);
  $("insightForecast").textContent = evaluation ? `Same-month-last-year baseline MAE: ${moneyless(evaluation.seasonal)} passenger records on ${evaluation.rows.length} ${evaluation.testYear} holdout months.` : "A full training year plus a later test year is needed for the forecast check.";

  const tableRows = makeCarrierRows(months, route).slice(0, 8);
  $("overviewTable").innerHTML = tableRows.length ? tableRows.map(rowHTML).join("") : '<tr><td colspan="5" class="table-empty">No route records in this window.</td></tr>';
  $("routeCount").textContent = `${number.format(tableRows.length)} shown`;
  $("tableSummary").textContent = `Top ${tableRows.length} airline-route combinations by passenger records`;
}

function renderExplorer() {
  if (!state.rows.length) return;
  const months = windowFrom("explorerPeriod");
  const route = $("routeFilter").value;
  const airline = $("airlineFilter").value;
  const search = $("routeSearch").value;
  const results = makeCarrierRows(months, route, airline, search);
  const pageCount = Math.max(1, Math.ceil(results.length / state.pageSize));
  state.explorerPage = Math.min(state.explorerPage, pageCount - 1);
  const start = state.explorerPage * state.pageSize;
  const shown = results.slice(start, start + state.pageSize);
  $("explorerTable").innerHTML = shown.length ? shown.map(rowHTML).join("") : '<tr><td colspan="5" class="table-empty">No matches. Try another route, airline, or search.</td></tr>';
  $("explorerCount").textContent = `${number.format(results.length)} results`;
  $("explorerSubtitle").textContent = `${months.length} months · ${route === "all" ? "all routes" : routeLabel(route)}`;
  $("paginationSummary").textContent = results.length ? `Showing ${number.format(start + 1)}–${number.format(Math.min(start + state.pageSize, results.length))} of ${number.format(results.length)}` : "No results";
  $("prevPage").disabled = state.explorerPage === 0;
  $("nextPage").disabled = state.explorerPage >= pageCount - 1;
}

function renderForecastPage() {
  if (!state.rows.length) return;
  const route = $("forecastRoute").value;
  const series = routeMonthly(route);
  const evaluation = evaluateForecast(series);
  const months = state.months;
  const actual = valuesFor(months, series);
  let seasonalValues = Array(months.length).fill(NaN);
  if (evaluation) {
    evaluation.rows.forEach((item) => {
      const index = months.indexOf(item.month);
      if (index >= 0) seasonalValues[index] = item.seasonal;
    });
  }
  drawChart($("forecastChart"), months, [
    { values: actual, className: "chart-line", points: true },
    { values: seasonalValues, className: "chart-forecast", pointClass: "forecast-point" }
  ], "Actual 2025 and 2026 passenger records compared with seasonal baseline");
  if (!evaluation) {
    $("forecastMae").textContent = "—";
    for (const id of ["maeSeasonal", "maePersistence", "maeLinear", "maePolynomial"]) $(id).textContent = "—";
    $("futureMonths").innerHTML = '<div class="chart-placeholder">This comparison needs a complete training year and a later holdout period.</div>';
    return;
  }
  $("forecastMae").textContent = moneyless(evaluation.seasonal);
  $("maeSeasonal").textContent = moneyless(evaluation.seasonal);
  $("maePersistence").textContent = moneyless(evaluation.persistence);
  $("maeLinear").textContent = moneyless(evaluation.linear);
  $("maePolynomial").textContent = moneyless(evaluation.polynomial);
  const forecasts = futureForecast(series, state.months, 6);
  $("futureMonths").innerHTML = forecasts.map((item) => `<div class="future-card"><span class="future-month">${esc(monthYear(item.month))}</span><strong class="future-value">${moneyless(item.value)}</strong><span class="future-note">${esc(item.basis)}</span></div>`).join("");
}

function renderDataPage() {
  if (!state.rows.length) {
    $("dataRows").textContent = "—";
    $("dataCoverage").textContent = "—";
    $("dataMonths").textContent = "No dataset loaded yet";
    $("dataPassengers").textContent = "—";
    $("dataStatusLarge").textContent = "Not loaded";
    $("dataStatusLarge").classList.remove("ready-text");
    return;
  }
  const total = [...state.monthly.values()].reduce((a, b) => a + b, 0);
  $("dataRows").textContent = number.format(state.rows.length);
  $("dataCoverage").textContent = `${monthText(state.months[0])} – ${monthText(state.months.at(-1))}`;
  $("dataMonths").textContent = `${state.months.length} monthly periods · ${state.fileName}`;
  $("dataPassengers").textContent = moneyless(total);
  $("dataStatusLarge").textContent = "Loaded";
  $("dataStatusLarge").classList.add("ready-text");
}

function renderAll() {
  if (!state.rows.length) return;
  populateDataStatus();
  renderDashboard();
  renderExplorer();
  renderForecastPage();
  renderDataPage();
  renderJourney();
}

function categoryValue(row, field) {
  if (field === "airline") return row.airline || "Unknown";
  if (field === "origin") return row.origin || "Unknown";
  if (field === "destination") return row.destination || "Unknown";
  const month = Number(row.month.slice(5, 7));
  return new Date(Date.UTC(2025, month - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

function renderEncodingDemo() {
  const target = $("oneHotView");
  if (!target) return;
  if (!state.rows.length) { target.innerHTML = '<div class="chart-placeholder">Load a CSV to see its category columns.</div>'; return; }
  const field = $("encodingFieldSelect").value;
  const counts = new Map();
  for (const row of state.rows) {
    const value = categoryValue(row, field);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const popular = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const columns = popular.map(([name]) => name);
  const example = categoryValue(state.rows[0], field);
  const encoded = columns.includes(example) ? example : "OTHER";
  if (encoded === "OTHER" && !columns.includes("OTHER")) columns.push("OTHER");
  const countsByName = new Map(popular);
  const total = state.rows.length;
  target.innerHTML = `<div class="onehot-live-grid"><div class="oh-label">CATEGORY</div>${columns.map((name) => `<div class="oh-head" title="${esc(name)}">${esc(name)}</div>`).join("")}<div class="oh-label">EXAMPLE VALUE</div>${columns.map((name) => `<div class="oh-cell ${name === encoded ? "is-one" : ""}">${name === encoded ? "1" : "0"}</div>`).join("")}<div class="oh-label">ROW COUNT</div>${columns.map((name) => `<div class="oh-count">${number.format(name === "OTHER" ? Math.max(0, total - popular.reduce((sum, item) => sum + item[1], 0)) : countsByName.get(name) || 0)}</div>`).join("")}</div><small class="onehot-caption">Example row uses “${esc(example)}” · ${columns.length} displayed categories</small>`;
}

function sampleForFeatureSelection(limit = 12000) {
  const stride = Math.max(1, Math.ceil(state.rows.length / limit));
  const sample = [];
  for (let i = 0; i < state.rows.length; i += stride) sample.push(state.rows[i]);
  return sample;
}

function entropy(counts, total) {
  let result = 0;
  for (const count of counts.values()) if (count) { const p = count / total; result -= p * Math.log2(p); }
  return result;
}

function scoreFeatureGroups(groups, target, method) {
  const n = target.length;
  if (n < 3 || groups.size < 2) return 0;
  if (method === "mi") {
    const bins = 6;
    const sorted = [...target].sort((a, b) => a - b);
    const cuts = Array.from({ length: bins - 1 }, (_, i) => sorted[Math.floor((i + 1) * n / bins)]);
    const targetBins = target.map((value) => cuts.findIndex((cut) => value <= cut) + 1);
    const yCounts = new Map(); targetBins.forEach((bin) => yCounts.set(bin, (yCounts.get(bin) || 0) + 1));
    const hy = entropy(yCounts, n);
    let conditional = 0;
    for (const indices of groups.values()) {
      const counts = new Map(); indices.forEach((index) => counts.set(targetBins[index], (counts.get(targetBins[index]) || 0) + 1));
      conditional += indices.length / n * entropy(counts, indices.length);
    }
    return Math.max(0, hy - conditional);
  }
  const mean = target.reduce((sum, value) => sum + value, 0) / n;
  let between = 0, within = 0;
  for (const indices of groups.values()) {
    if (!indices.length) continue;
    const groupMean = indices.reduce((sum, index) => sum + target[index], 0) / indices.length;
    between += indices.length * (groupMean - mean) ** 2;
    for (const index of indices) within += (target[index] - groupMean) ** 2;
  }
  return within > 0 ? (between / Math.max(1, groups.size - 1)) / (within / Math.max(1, n - groups.size)) : 0;
}

function computeFeatureRanks(method) {
  const rows = sampleForFeatureSelection();
  const targets = rows.map((row) => Math.log1p(row.passengers));
  const distances = rows.map((row) => Math.log1p(Math.max(0, row.distance)));
  const sortedDistances = [...distances].sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map((q) => sortedDistances[Math.floor((sortedDistances.length - 1) * q)] ?? 0);
  const fields = ["airline", "origin", "destination", "month", "distance"];
  const results = fields.map((field) => {
    const groups = new Map();
    rows.forEach((row, index) => {
      let value = field === "distance" ? `Q${cuts.findIndex((cut) => distances[index] <= cut) + 1 || 4}` : field === "month" ? row.month.slice(5, 7) : row[field];
      if (["airline", "origin", "destination"].includes(field)) value = String(value || "Unknown");
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(index);
    });
    if (["airline", "origin", "destination"].includes(field)) {
      const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      const top = new Set(ranked.slice(0, 16).map(([key]) => key));
      const compactGroups = new Map();
      for (const [key, indices] of groups) {
        const useKey = top.has(key) ? key : "OTHER";
        if (!compactGroups.has(useKey)) compactGroups.set(useKey, []);
        compactGroups.get(useKey).push(...indices);
      }
      return { feature: field === "distance" ? "Distance" : field[0].toUpperCase() + field.slice(1), score: scoreFeatureGroups(compactGroups, targets, method) };
    }
    return { feature: field === "distance" ? "Distance (quartiles)" : "Month of year", score: scoreFeatureGroups(groups, targets, method) };
  });
  return results.sort((a, b) => b.score - a.score);
}

function renderFeatureRanking() {
  const host = $("featureRanking");
  if (!host) return;
  if (!state.rows.length) { host.innerHTML = '<div class="chart-placeholder">Import data to calculate feature scores.</div>'; return; }
  const method = $("featureMethodSelect").value;
  const results = computeFeatureRanks(method);
  const max = Math.max(1e-9, ...results.map((item) => item.score));
  $("featureSampleNote").textContent = `Calculated on a deterministic sample of ${number.format(Math.min(state.rows.length, 12000))} rows · target is log passenger count`;
  host.innerHTML = `<div class="feature-ranking-heading"><b>${method === "f" ? "F-test signal by field" : "Mutual information by field"}</b><span>Higher score = stronger observed association</span></div>${results.map((item, index) => `<div class="feature-rank-row"><span class="rank-index">${String(index + 1).padStart(2, "0")}</span><b>${esc(item.feature)}</b><i><em style="width:${Math.max(2, item.score / max * 100)}%"></em></i><strong>${method === "f" ? item.score.toFixed(1) : item.score.toFixed(3)}</strong></div>`).join("")}<small class="feature-ranking-note">F-test uses an ANOVA-style group score; mutual information uses discretized values. These browser-side rankings are educational approximations, distinct from the scikit-learn notebook results below.</small>`;
}

function fillJourneyRouteOptions() {
  const select = $("journeyRoute");
  if (!select || !state.rows.length) return;
  const old = select.value || state.journeyRoute;
  const popular = [...state.routes.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 100);
  select.innerHTML = '<option value="all">All routes</option>' + popular.map(([key]) => `<option value="${esc(key)}">${esc(routeLabel(key))}</option>`).join("");
  select.value = popular.some(([key]) => key === old) ? old : "all";
  state.journeyRoute = select.value;
}

function renderJourneyModels() {
  const host = $("journeyModelChart");
  if (!host) return;
  if (!state.rows.length) return;
  const route = $("journeyRoute").value || "all";
  const method = $("journeyModelMethod").value || "seasonal";
  const series = routeMonthly(route);
  const evaluation = evaluateForecast(series);
  if (!evaluation) {
    $("journeyModelSummary").textContent = "A complete training year plus a later holdout period is needed to calculate this comparison.";
    host.innerHTML = '<div class="chart-placeholder">This dataset does not have enough months for a chronological holdout.</div>';
    return;
  }
  const modelLabels = { seasonal: "Seasonal naive", persistence: "Persistence", linear: "Linear trend", polynomial: "Polynomial trend" };
  const error = evaluation[method];
  $("journeyModelSummary").innerHTML = `<span>${esc(routeLabel(route))}</span><b>${esc(modelLabels[method])} MAE: ${moneyless(error)}</b><small>Trained on ${evaluation.trainYear} · tested on ${evaluation.testYear} (${evaluation.rows.length} months) · actual vs estimated monthly totals</small>`;
  drawChart(host, evaluation.rows.map((row) => row.month), [
    { values: evaluation.rows.map((row) => row.actual), className: "chart-line", points: true },
    { values: evaluation.rows.map((row) => row[method]), className: "chart-forecast", pointClass: "forecast-point", points: true }
  ], `Actual passenger totals compared with ${modelLabels[method]} predictions`);
}

function renderJourneyPrediction() {
  if (!state.rows.length) return;
  const route = $("journeyRoute").value || "all";
  const prediction = futureForecast(routeMonthly(route), state.months, 1)[0];
  $("journeyPredictionValue").textContent = prediction ? moneyless(prediction.value) : "—";
  $("journeyPredictionLabel").textContent = prediction ? `${monthYear(prediction.month)} · ${routeLabel(route)} · ${prediction.basis}` : "More history is needed for an estimate.";
}

const IRIS_VARIANCE = [72.96, 22.85, 3.67, 0.52];
function renderPcaSlider() {
  const slider = $("pcaComponentSlider");
  if (!slider) return;
  const components = Number(slider.value);
  const retained = IRIS_VARIANCE.slice(0, components).reduce((sum, value) => sum + value, 0);
  $("pcaVarianceOutput").textContent = `${components} component${components === 1 ? "" : "s"} · ${retained.toFixed(1)}% variance retained`;
  $("pcaComponentCount").textContent = components;
  $("pcaTotalVariance").textContent = `${retained.toFixed(1)}%`;
  document.querySelectorAll("[data-pc-bar]").forEach((bar) => {
    const index = Number(bar.dataset.pcBar) - 1;
    bar.hidden = index >= components;
    const value = IRIS_VARIANCE[index];
    bar.querySelector("strong").textContent = `${value.toFixed(2)}%`;
    bar.querySelector("b").style.width = `${value / IRIS_VARIANCE[0] * 100}%`;
  });
}

function renderDataProfile() {
  const body = $("dataProfileBody");
  if (!body) return;
  if (!state.columnAudit.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">Import a CSV to profile every source column.</td></tr>';
    $("profileShape").textContent = "Awaiting CSV";
    $("profileColumnSplit").textContent = "Numeric and categorical columns";
    $("demandBinsView").innerHTML = '<div class="chart-placeholder">Demand ranges will be calculated from your uploaded values.</div>';
    return;
  }
  const audit = state.columnAudit;
  $("profileShape").textContent = `${number.format(state.quality?.sourceRows || state.rows.length)} rows × ${audit.length} columns`;
  const numeric = audit.filter((x) => x.inferredType === "Numeric").map((x) => x.name);
  const categorical = audit.filter((x) => x.inferredType === "Categorical / text").map((x) => x.name);
  const dates = audit.filter((x) => x.inferredType === "Date/time").map((x) => x.name);
  $("profileColumnSplit").textContent = `Numeric: ${numeric.join(", ") || "none"} · Categorical/text: ${categorical.join(", ") || "none"} · Date/time: ${dates.join(", ") || "none"}`;
  body.innerHTML = audit.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.inferredType}</td><td>${number.format(x.missing)}</td><td>${x.missingPct.toFixed(2)}%</td><td>${x.mean == null ? "—" : number.format(x.mean)}</td><td>${x.min == null ? "—" : `${number.format(x.min)} – ${number.format(x.max)}`}</td></tr>`).join("");
  const values = state.rows.map((r) => r.passengers).filter(Number.isFinite).sort((a,b)=>a-b);
  const at = (q) => values[Math.min(values.length-1, Math.floor((values.length-1)*q))] || 0;
  const cuts = [at(.25), at(.5), at(.75)];
  const bins = [{label:"Low",lo:values[0]||0,hi:cuts[0]}, {label:"Mid-low",lo:cuts[0],hi:cuts[1]}, {label:"Mid-high",lo:cuts[1],hi:cuts[2]}, {label:"High",lo:cuts[2],hi:values.at(-1)||0}];
  $("demandBinsView").innerHTML = `<div class="bin-row">${bins.map((b,i)=>`<div class="bin-item"><b>${b.label}</b><strong>${number.format(b.lo)}–${number.format(b.hi)}</strong><small>passengers · quartile ${i+1}</small></div>`).join("")}</div><p class="footnote">Equal-frequency bins recalculated from this upload. They help describe demand tiers; the binned target is excluded from passenger-count model inputs to prevent leakage.</p>`;
  const dist = state.columnAudit.find((x)=>/^distance$/i.test(x.name));
  const distances = state.rows.map((r)=>r.distance).filter((v)=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
  const q=(a,p)=>a.length?a[Math.floor((a.length-1)*p)]:0;
  const summarizeOutliers=(a)=>{const q1=q(a,.25),q3=q(a,.75),lim=q3+1.5*(q3-q1);return {count:a.filter(v=>v>lim).length,lim};};
  const paxFlags=summarizeOutliers(values), distFlags=summarizeOutliers(distances);
  $("outlierSummary").textContent = `IQR review: ${number.format(paxFlags.count)} passenger-count flags above ${number.format(paxFlags.lim)} and ${number.format(distFlags.count)} positive-distance flags above ${number.format(distFlags.lim)}. These are review flags, not automatic errors.`;
  $("transformSummary").textContent = dist ? `DISTANCE ranges ${number.format(dist.min)}–${number.format(dist.max)}. Model pipelines impute and standardize numeric features on training rows; Notebook 01 compares skew before and after log1p.` : "Numeric feature scaling and skew transforms are demonstrated in Notebook 01 and fitted inside model pipelines where required.";
}

function renderJourney() {
  if (!$("journeyRows")) return;
  if (!state.rows.length) {
    $("journeyRows").textContent = "Awaiting CSV";
    $("journeyMonths").textContent = "—";
    $("journeyPeriod").textContent = "Reporting period";
    $("journeyRoutes").textContent = "—";
    $("journeyAirlines").textContent = "Airlines in uploaded data";
    $("journeyPassengers").textContent = "—";
    $("journeyPredictionValue").textContent = "—";
    $("journeyPredictionLabel").textContent = "Import a CSV to calculate a seasonal estimate.";
    for (const id of ["qualitySourceRows", "qualityAcceptedRows", "qualityInvalidRows", "qualityRepeatedKeys", "qualityZeroRows", "qualityOutliers"]) $(id).textContent = "—";
    renderDataProfile(); renderEncodingDemo(); renderFeatureRanking(); renderJourneyModels(); renderPcaSlider(); renderClassifier();
    return;
  }
  const total = [...state.monthly.values()].reduce((sum, value) => sum + value, 0);
  $("journeyRows").textContent = number.format(state.rows.length);
  $("journeyMonths").textContent = `${state.months.length} months`;
  $("journeyPeriod").textContent = `${monthText(state.months[0])} – ${monthText(state.months.at(-1))}`;
  $("journeyRoutes").textContent = number.format(state.routes.size);
  $("journeyAirlines").textContent = `${number.format(state.airlines.length)} airline labels`;
  $("journeyPassengers").textContent = moneyless(total);
  $("journeyChartCaption").textContent = `${state.fileName} · ${state.months.length} monthly periods`;
  drawChart($("journeyTrafficChart"), state.months, [{ values: valuesFor(state.months, state.monthly), className: "chart-line", points: true }], "Monthly passengers in the uploaded dataset");
  const quality = state.quality || {};
  $("qualitySourceRows").textContent = number.format(quality.sourceRows ?? state.rows.length);
  $("qualityAcceptedRows").textContent = number.format(state.rows.length);
  $("qualityInvalidRows").textContent = number.format(quality.invalidRows || 0);
  $("qualityRepeatedKeys").textContent = number.format(quality.repeatedMonthlyKeys || 0);
  $("qualityZeroRows").textContent = number.format(quality.zeroPassengerRows || 0);
  $("qualityOutliers").textContent = number.format(quality.outliers ?? 0);
  renderDataProfile(); renderEncodingDemo(); renderFeatureRanking(); fillJourneyRouteOptions(); renderJourneyModels(); renderPcaSlider(); renderClassifier();
  renderJourneyPrediction();
}

function sampleRows(rows, limit) {
  const stride = Math.max(1, Math.ceil(rows.length / limit));
  const result = [];
  for (let i = 0; i < rows.length; i += stride) result.push(rows[i]);
  return result;
}

function logisticFeatures(row) {
  const month = Number(row.month.slice(5, 7));
  return [Math.log1p(Math.max(0, row.distance)), Math.sin(2 * Math.PI * month / 12), Math.cos(2 * Math.PI * month / 12)];
}

function trainBrowserClassifier() {
  const years = [...new Set(state.months.map((month) => Number(month.slice(0, 4))))].sort((a, b) => a - b);
  let trainRows, testRows, trainLabel;
  if (years.length > 1) {
    const testYear = years.at(-1);
    trainRows = state.rows.filter((row) => Number(row.month.slice(0, 4)) < testYear);
    testRows = state.rows.filter((row) => Number(row.month.slice(0, 4)) === testYear);
    trainLabel = `trained before ${testYear} · tested on ${testYear}`;
  } else if (state.months.length >= 4) {
    const splitAt = Math.max(1, Math.floor(state.months.length * 0.75));
    const cutoff = state.months[splitAt];
    trainRows = state.rows.filter((row) => row.month < cutoff);
    testRows = state.rows.filter((row) => row.month >= cutoff);
    trainLabel = `trained before ${monthText(cutoff)} · tested from ${monthText(cutoff)}`;
  } else return null;
  const train = sampleRows(trainRows, 16000);
  const test = sampleRows(testRows, 8000);
  if (train.length < 20 || test.length < 10) return null;
  const sortedTargets = train.map((row) => row.passengers).sort((a, b) => a - b);
  const demandCutoff = sortedTargets[Math.floor((sortedTargets.length - 1) * 0.75)];
  const xTrain = train.map(logisticFeatures);
  const means = [0, 1, 2].map((j) => xTrain.reduce((sum, x) => sum + x[j], 0) / xTrain.length);
  const scales = [0, 1, 2].map((j) => Math.sqrt(xTrain.reduce((sum, x) => sum + (x[j] - means[j]) ** 2, 0) / xTrain.length) || 1);
  const normalize = (x) => x.map((value, j) => (value - means[j]) / scales[j]);
  const trainX = xTrain.map(normalize);
  const trainY = train.map((row) => row.passengers >= demandCutoff ? 1 : 0);
  let positives = trainY.reduce((sum, y) => sum + y, 0);
  let weights = [0, 0, 0];
  let bias = Math.log((positives + 1) / (trainY.length - positives + 1));
  const rate = 0.14;
  for (let iteration = 0; iteration < 240; iteration++) {
    const gradients = [0, 0, 0]; let biasGradient = 0;
    for (let i = 0; i < trainX.length; i++) {
      const x = trainX[i];
      const z = Math.max(-30, Math.min(30, bias + weights[0] * x[0] + weights[1] * x[1] + weights[2] * x[2]));
      const probability = 1 / (1 + Math.exp(-z));
      const error = probability - trainY[i];
      biasGradient += error;
      for (let j = 0; j < 3; j++) gradients[j] += error * x[j];
    }
    bias -= rate * biasGradient / trainX.length;
    for (let j = 0; j < 3; j++) weights[j] -= rate * (gradients[j] / trainX.length + 0.002 * weights[j]);
  }
  const probabilities = test.map((row) => {
    const x = normalize(logisticFeatures(row));
    const z = Math.max(-30, Math.min(30, bias + weights[0] * x[0] + weights[1] * x[1] + weights[2] * x[2]));
    return 1 / (1 + Math.exp(-z));
  });
  const labels = test.map((row) => row.passengers >= demandCutoff ? 1 : 0);
  return { rows: test.length, probabilities, labels, demandCutoff, trainLabel, sourceRows: state.rows };
}

function classifierMetrics(model, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  model.labels.forEach((actual, i) => {
    const predicted = model.probabilities[i] >= threshold ? 1 : 0;
    if (actual && predicted) tp++;
    else if (actual && !predicted) fn++;
    else if (!actual && predicted) fp++;
    else tn++;
  });
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const accuracy = (tp + tn) / model.labels.length;
  const f1 = 2 * precision * recall / (precision + recall) || 0;
  const positiveBins = Array(100).fill(0), negativeBins = Array(100).fill(0);
  model.probabilities.forEach((probability, index) => {
    const bin = Math.min(99, Math.floor(probability * 100));
    if (model.labels[index]) positiveBins[bin]++;
    else negativeBins[bin]++;
  });
  const positives = positiveBins.reduce((a, b) => a + b, 0), negatives = negativeBins.reduce((a, b) => a + b, 0);
  let lowerNegatives = 0, aucArea = 0;
  for (let bin = 0; bin < 100; bin++) { aucArea += positiveBins[bin] * (lowerNegatives + negativeBins[bin] / 2); lowerNegatives += negativeBins[bin]; }
  const auc = positives && negatives ? aucArea / (positives * negatives) : 0;
  return { tp, fp, tn, fn, precision, recall, accuracy, f1, auc };
}

function renderClassifier() {
  const matrix = $("classificationMatrix");
  if (!matrix) return;
  if (!state.rows.length) { matrix.innerHTML = '<div class="chart-placeholder">Import passenger data to train the classifier.</div>'; return; }
  if (!state.classifier || state.classifier.sourceRows !== state.rows) state.classifier = trainBrowserClassifier();
  const model = state.classifier;
  if (!model) {
    $("classifierDescription").textContent = "This upload needs at least four monthly periods, with enough records in both the training and test periods.";
    matrix.innerHTML = '<div class="chart-placeholder">Not enough data for a chronological classification split.</div>';
    return;
  }
  const threshold = Number($("clsThreshold").value);
  const metrics = classifierMetrics(model, threshold);
  $("clsThresholdOutput").textContent = `${Math.round(threshold * 100)}%`;
  $("classifierDescription").textContent = `High demand = at least ${number.format(model.demandCutoff)} passenger records (training-set 75th percentile). ${model.trainLabel} · ${number.format(model.rows)} test records.`;
  $("clsAccuracy").textContent = `${(metrics.accuracy * 100).toFixed(1)}%`;
  $("clsPrecision").textContent = `${(metrics.precision * 100).toFixed(1)}%`;
  $("clsRecall").textContent = `${(metrics.recall * 100).toFixed(1)}%`;
  $("clsF1").textContent = `${(metrics.f1 * 100).toFixed(1)}%`;
  $("clsAuc").textContent = metrics.auc.toFixed(3);
  const max = Math.max(1, metrics.tp, metrics.fp, metrics.tn, metrics.fn);
  matrix.innerHTML = `<div class="matrix-caption">CONFUSION MATRIX <span>Rows = actual · columns = predicted</span></div><div class="confusion-grid"><span></span><b>Normal</b><b>High</b><b>Actual normal</b><strong>${number.format(metrics.tn)}</strong><strong class="matrix-error">${number.format(metrics.fp)}</strong><b>Actual high</b><strong class="matrix-error">${number.format(metrics.fn)}</strong><strong class="matrix-hit">${number.format(metrics.tp)}</strong></div><div class="confusion-legend"><span><i class="matrix-hit-dot"></i>Correctly classified</span><span><i class="matrix-error-dot"></i>Incorrectly classified</span><span class="confusion-total">${number.format(model.rows)} held-out records</span></div><div class="matrix-mini-bars"><span>True high records captured</span><i><b style="width:${metrics.recall * 100}%"></b></i><strong>${(metrics.recall * 100).toFixed(1)}%</strong></div>`;
}

function openDatasetDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("This browser does not allow local dataset storage.")); return; }
    const request = window.indexedDB.open(DATA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATA_STORE_NAME)) database.createObjectStore(DATA_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local browser storage."));
    request.onblocked = () => reject(new Error("Local browser storage is busy in another tab."));
  });
}

async function saveDatasetForNextVisit(file) {
  const database = await openDatasetDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DATA_STORE_NAME, "readwrite");
      transaction.objectStore(DATA_STORE_NAME).put({
        id: SAVED_DATASET_KEY,
        name: file.name,
        blob: file.slice(0, file.size, file.type || "text/csv"),
        savedAt: Date.now()
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save this dataset."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving the dataset was cancelled."));
    });
  } finally { database.close(); }
}

async function getSavedDataset() {
  const database = await openDatasetDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(DATA_STORE_NAME, "readonly");
      const request = transaction.objectStore(DATA_STORE_NAME).get(SAVED_DATASET_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read the saved dataset."));
    });
  } finally { database.close(); }
}

async function deleteSavedDataset() {
  const database = await openDatasetDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DATA_STORE_NAME, "readwrite");
      transaction.objectStore(DATA_STORE_NAME).delete(SAVED_DATASET_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not delete the saved dataset."));
      transaction.onabort = () => reject(transaction.error || new Error("Deleting the dataset was cancelled."));
    });
  } finally { database.close(); }
}

async function deleteDataset() {
  if (!state.rows.length) return;
  const approved = window.confirm("Delete the imported dataset from this dashboard and this browser? You can import it again later.");
  if (!approved) return;
  try {
    await deleteSavedDataset();
    state.rows = [];
    state.months = [];
    state.monthly = new Map();
    state.routes = new Map();
    state.carrierRoutes = new Map();
    state.routeKeys = [];
    state.airlines = [];
    state.demandThresholds.clear();
    state.fileName = "";
  state.quality = null;
    state.explorerPage = 0;
    $("routeFilter").innerHTML = '<option value="all">All routes</option>';
    $("forecastRoute").innerHTML = '<option value="all">All routes</option>';
    $("airlineFilter").innerHTML = '<option value="all">All airlines</option>';
    $("routeSearch").value = "";
    $("fileInput").value = "";
    $("sidebarDataStatus").textContent = "Waiting for dataset";
    $("sidebarPeriod").textContent = "BTS · monthly data";
    $("topDataStatus").textContent = "No dataset loaded";
    $("statusLight").classList.remove("ready");
    $("topStatusLight").classList.remove("ready");
    $("exportButton").disabled = true;
    $("deleteDataButton").disabled = true;
    $("ribbonPeriod").textContent = "—";
    $("dataRibbonText").textContent = "Official BTS monthly market records. New months appear after you import an updated release.";
    document.body.classList.remove("has-data");
    setPage("dashboard");
    toast("Dataset deleted from this browser");
  } catch (error) {
    toast(error.message || "Could not delete the saved dataset");
  }
}

async function restoreSavedDataset() {
  try {
    const saved = await getSavedDataset();
    if (!saved?.blob) return;
    $("topDataStatus").textContent = "Restoring saved dataset…";
    const loaded = await parsePassengerCSV(await saved.blob.text(), saved.name);
    applyLoadedDataset(loaded, saved.name);
    toast("Your saved dataset is ready");
  } catch (error) {
    $("topDataStatus").textContent = "Saved dataset could not be restored";
    toast("Could not restore saved data · please import the CSV again");
  }
}

function applyLoadedDataset(loaded, fileName) {
  state.rows = loaded.rows;
  state.monthly = loaded.monthly;
  state.routes = loaded.routes;
  state.carrierRoutes = loaded.carrierRoutes;
  state.demandThresholds.clear();
  state.airlines = loaded.airlines;
  state.routeKeys = [...loaded.routes.keys()].sort();
  state.months = loaded.months;
  state.fileName = fileName;
  const sortedPassengers = state.rows.map((row) => row.passengers).sort((a, b) => a - b);
  const q1 = sortedPassengers[Math.floor((sortedPassengers.length - 1) * 0.25)] || 0;
  const q3 = sortedPassengers[Math.floor((sortedPassengers.length - 1) * 0.75)] || 0;
  const outlierLimit = q3 + 1.5 * (q3 - q1);
  state.columnAudit = loaded.columnAudit || [];
  state.quality = { ...(loaded.quality || {}), outliers: sortedPassengers.filter((value) => value > outlierLimit).length, outlierLimit };
  state.explorerPage = 0;
  populateFilters();
  populateDataStatus();
  $("routeFilter").value = "all";
  $("forecastRoute").value = "all";
  $("airlineFilter").value = "all";
  $("periodFilter").value = "12";
  $("explorerPeriod").value = "12";
  $("routeSearch").value = "";
  setPage(state.page);
  renderAll();
}

async function importFile(file) {
  if (!file) return;
  setNotice(`Loading ${file.name}…`, "success");
  try {
    const text = await file.text();
    const loaded = await parsePassengerCSV(text, file.name);
    applyLoadedDataset(loaded, file.name);
    try {
      await saveDatasetForNextVisit(file);
      setNotice(`Loaded and saved ${number.format(state.rows.length)} usable records from ${file.name} in this browser.`, "success");
      toast("Dataset loaded and saved in this browser");
    } catch {
      setNotice(`Loaded ${number.format(state.rows.length)} records for this session. Browser storage was unavailable, so import the CSV again next time.`, "error");
      toast("Loaded for this session · could not save locally");
    }
  } catch (error) {
    setNotice(error.message || "Could not read this CSV file.", "error");
    toast("Import failed · check the CSV columns");
  }
}

function exportCurrentView() {
  const months = state.page === "explorer" ? windowFrom("explorerPeriod") : windowFrom("periodFilter");
  const monthSet = new Set(months);
  const route = $("routeFilter").value;
  const airline = state.page === "explorer" ? $("airlineFilter").value : "all";
  const search = state.page === "explorer" ? $("routeSearch").value.trim().toLowerCase() : "";
  const selected = state.rows.filter((row) => monthSet.has(row.month) && (route === "all" || row.route === route) && (airline === "all" || row.airline === airline) && (!search || `${row.origin} ${row.destination} ${row.airline}`.toLowerCase().includes(search)));
  if (!selected.length) { toast("No rows match the current filters"); return; }
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const header = "month,origin,destination,airline,passengers,distance";
  const body = selected.map((row) => `${row.month},${row.origin},${row.destination},${quote(row.airline)},${row.passengers},${row.distance}`).join("\n");
  const url = URL.createObjectURL(new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "aerotrack-filtered-passenger-data.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${number.format(selected.length)} filtered records`);
}

function setRoute(route) {
  $("routeFilter").value = route;
  $("forecastRoute").value = route;
  state.explorerPage = 0;
  if (state.page === "explorer") renderExplorer();
  else renderDashboard();
  renderForecastPage();
  toast(route === "all" ? "Showing all routes" : `Focused on ${routeLabel(route)}`);
}
function setSort(sortBy) {
  if (state.sortBy === sortBy) state.sortDirection *= -1;
  else { state.sortBy = sortBy; state.sortDirection = sortBy === "passengers" ? -1 : 1; }
  state.explorerPage = 0;
  renderDashboard();
  renderExplorer();
}

function wireEvents() {
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelectorAll("[data-trigger-import]").forEach((button) => button.addEventListener("click", () => $("fileInput").click()));
  $("importButton").addEventListener("click", () => $("fileInput").click());
  $("emptyImportButton").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (event) => { await importFile(event.target.files[0]); event.target.value = ""; });
  $("exportButton").addEventListener("click", exportCurrentView);
  $("deleteDataButton").addEventListener("click", deleteDataset);
  $("encodingFieldSelect").addEventListener("change", renderEncodingDemo);
  $("featureMethodSelect").addEventListener("change", renderFeatureRanking);
  $("journeyRoute").addEventListener("change", (event) => { state.journeyRoute = event.target.value; renderJourneyModels(); renderJourneyPrediction(); });
  $("journeyModelMethod").addEventListener("change", renderJourneyModels);
  $("pcaComponentSlider").addEventListener("input", renderPcaSlider);
  $("clsThreshold").addEventListener("input", renderClassifier);
  $("routeFilter").addEventListener("change", () => { $("forecastRoute").value = $("routeFilter").value; state.explorerPage = 0; renderAll(); });
  $("periodFilter").addEventListener("change", () => { state.explorerPage = 0; renderAll(); });
  $("explorerPeriod").addEventListener("change", () => { state.explorerPage = 0; renderExplorer(); });
  $("forecastRoute").addEventListener("change", renderForecastPage);
  $("airlineFilter").addEventListener("change", () => { state.explorerPage = 0; renderExplorer(); });
  $("routeSearch").addEventListener("input", () => { state.explorerPage = 0; renderExplorer(); });
  $("clearFilters").addEventListener("click", () => {
    $("routeFilter").value = "all"; $("forecastRoute").value = "all"; $("airlineFilter").value = "all";
    $("routeSearch").value = ""; $("explorerPeriod").value = "12"; $("periodFilter").value = "12";
    state.explorerPage = 0; renderAll(); toast("Filters cleared");
  });
  $("prevPage").addEventListener("click", () => { state.explorerPage = Math.max(0, state.explorerPage - 1); renderExplorer(); });
  $("nextPage").addEventListener("click", () => { state.explorerPage++; renderExplorer(); });
  document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => setSort(button.dataset.sort)));
  $("metricBusiest").addEventListener("click", () => {
    const rows = makeCarrierRows(windowFrom("periodFilter"), $("routeFilter").value);
    if (rows[0]) { setRoute(rows[0].route); setPage("explorer"); }
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-route]");
    if (!button) return;
    const route = button.dataset.openRoute;
    setRoute(route);
    setPage("explorer");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.page !== "dashboard") setPage("dashboard");
  });
}

wireEvents();
setPage("dashboard");
restoreSavedDataset();
