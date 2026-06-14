"use strict";

const RECORDS_KEY = "dietTracker.records.v1";
const SETTINGS_KEY = "dietTracker.settings.v1";
const SYNC_KEY = "dietTracker.sync.v1";
const APP_VERSION = 3;

const DEFAULT_TEMPLATES = [
  { id: "protein", name: "プロテイン", calories: 120, protein: 24, fat: 2, carbs: 4 },
  { id: "rice150", name: "ごはん 150g", calories: 234, protein: 3.8, fat: 0.5, carbs: 53.4 }
];

const $ = (id) => document.getElementById(id);
const pad = (value) => String(value).padStart(2, "0");
const todayISO = () => {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let records = migrateRecords(readStorage(RECORDS_KEY, {}));
let settings = migrateSettings(readStorage(SETTINGS_KEY, {}));
let syncState = { dirty: false, lastAttemptAt: "", lastConfirmedAt: "", lastError: "", ...readStorage(SYNC_KEY, {}) };
let currentPage = "dashboard";
let chartDays = 7;
let historyRange = "30";
let syncTimer = null;
let syncInFlight = false;
let toastTimer = null;

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function parseBoolean(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Old records are normalized on every load so the v1 storage key remains compatible.
function migrateRecords(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const migrated = {};
  Object.entries(source).forEach(([key, raw]) => {
    if (!raw || typeof raw !== "object") return;
    const date = String(raw.date || key).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    migrated[date] = {
      ...raw,
      date,
      weight: nullableNumber(raw.weight),
      calories: nullableNumber(raw.calories),
      protein: nullableNumber(raw.protein),
      water: nullableNumber(raw.water),
      steps: nullableNumber(raw.steps),
      proteinCount: nullableNumber(raw.proteinCount),
      training: String(raw.training || ""),
      meals: String(raw.meals || ""),
      memo: String(raw.memo || raw.conditionMemo || ""),
      diningOut: parseBoolean(raw.diningOut),
      alcohol: parseBoolean(raw.alcohol),
      swelling: parseBoolean(raw.swelling),
      cheatDay: parseBoolean(raw.cheatDay),
      updatedAt: raw.updatedAt || ""
    };
  });
  return migrated;
}

function parseTemplates(value) {
  let templates = value;
  if (typeof templates === "string") {
    try { templates = JSON.parse(templates); } catch { templates = []; }
  }
  if (!Array.isArray(templates)) return [];
  return templates
    .filter((item) => item && item.name)
    .map((item, index) => ({
      id: String(item.id || `template-${index}-${Date.now()}`),
      name: String(item.name),
      calories: nullableNumber(item.calories) || 0,
      protein: nullableNumber(item.protein) || 0,
      fat: nullableNumber(item.fat) || 0,
      carbs: nullableNumber(item.carbs) || 0
    }));
}

function migrateSettings(source) {
  const base = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const hasTemplates = Object.prototype.hasOwnProperty.call(base, "mealTemplates");
  return {
    ...base,
    targetWeight: nullableNumber(base.targetWeight),
    targetCalories: nullableNumber(base.targetCalories),
    targetProtein: nullableNumber(base.targetProtein),
    targetWater: nullableNumber(base.targetWater),
    gasUrl: String(base.gasUrl || ""),
    autoSyncEnabled: base.autoSyncEnabled === "off" ? "off" : "on",
    autoLoadEnabled: base.autoLoadEnabled === "on" ? "on" : "off",
    syncIntervalMinutes: Number(base.syncIntervalMinutes || 5),
    theme: ["light", "dark", "system"].includes(base.theme) ? base.theme : "system",
    mealTemplates: hasTemplates ? parseTemplates(base.mealTemplates) : DEFAULT_TEMPLATES.map((item) => ({ ...item }))
  };
}

function saveRecords() {
  writeStorage(RECORDS_KEY, records);
}

function saveSettings() {
  writeStorage(SETTINGS_KEY, settings);
}

function saveSyncState() {
  writeStorage(SYNC_KEY, syncState);
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return "--";
  return Number(value).toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function signed(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)} kg`;
}

function dateLabel(dateString, includeYear = false) {
  const [year, month, day] = dateString.split("-");
  return includeYear ? `${year}/${month}/${day}` : `${Number(month)}/${Number(day)}`;
}

function dateTimeLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function sortedRecords(desc = true) {
  const result = Object.values(records).sort((a, b) => a.date.localeCompare(b.date));
  return desc ? result.reverse() : result;
}

function datesForDays(days) {
  const result = [];
  const base = new Date(`${todayISO()}T12:00:00`);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(base);
    date.setDate(base.getDate() - offset);
    result.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  }
  return result;
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function switchPage(page, options = {}) {
  currentPage = page;
  document.querySelectorAll(".page").forEach((section) => section.classList.toggle("is-active", section.id === page));
  document.querySelectorAll(".bottom-nav button").forEach((button) => button.classList.toggle("is-active", button.dataset.page === page));
  $("pageTitle").textContent = $(page).dataset.title;
  $("saveDock").classList.toggle("is-visible", page === "entry");
  window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });

  if (page === "dashboard") renderDashboard();
  if (page === "history") renderHistory();
  if (page === "settings") renderSettings();
  if (page === "entry" && options.date) loadEntry(options.date);
}

function setInputValue(id, value) {
  $(id).value = value ?? "";
}

function loadEntry(date = todayISO()) {
  const record = records[date] || {};
  $("date").value = date;
  setInputValue("weight", record.weight);
  setInputValue("calories", record.calories);
  setInputValue("protein", record.protein);
  setInputValue("steps", record.steps);
  setInputValue("water", record.water);
  setInputValue("proteinCount", record.proteinCount);
  setInputValue("training", record.training);
  setInputValue("meals", record.meals);
  setInputValue("memo", record.memo);
  $("diningOut").checked = Boolean(record.diningOut);
  $("alcohol").checked = Boolean(record.alcohol);
  $("swelling").checked = Boolean(record.swelling);
  $("cheatDay").checked = Boolean(record.cheatDay);

  const editing = Boolean(records[date]);
  $("entryMode").textContent = editing ? "EDIT ENTRY" : "NEW ENTRY";
  $("entryTitle").textContent = date === todayISO() ? "今日の記録" : `${dateLabel(date, true)} の記録`;
  $("saveDockTitle").textContent = editing ? "記録を更新" : "記録を保存";
  $("saveDockStatus").textContent = editing ? "入力済み" : "未保存";
  $("deleteBtn").hidden = !editing;
}

function valueFromInput(id) {
  return nullableNumber($(id).value);
}

function saveEntry(event) {
  event.preventDefault();
  const date = $("date").value || todayISO();
  const existing = records[date] || {};
  const record = {
    ...existing,
    date,
    weight: valueFromInput("weight"),
    calories: valueFromInput("calories"),
    protein: valueFromInput("protein"),
    steps: valueFromInput("steps"),
    water: valueFromInput("water"),
    proteinCount: valueFromInput("proteinCount"),
    training: $("training").value.trim(),
    meals: $("meals").value.trim(),
    memo: $("memo").value.trim(),
    diningOut: $("diningOut").checked,
    alcohol: $("alcohol").checked,
    swelling: $("swelling").checked,
    cheatDay: $("cheatDay").checked,
    updatedAt: new Date().toISOString()
  };
  const contentKeys = [
    "weight", "calories", "protein", "steps", "water", "proteinCount", "training",
    "meals", "memo", "diningOut", "alcohol", "swelling", "cheatDay"
  ];
  if (!contentKeys.some((key) => record[key] !== null && record[key] !== "" && record[key] !== false)) {
    showToast("入力内容がありません");
    return;
  }

  records[date] = record;
  saveRecords();
  markDirty();
  loadEntry(date);
  renderDashboard();
  showToast(existing.date ? "記録を更新しました" : "ローカルに保存しました");
  syncToCloud("auto");
}

function deleteEntry() {
  const date = $("date").value;
  if (!records[date]) return;
  if (!window.confirm(`${date} の記録を削除しますか？`)) return;
  delete records[date];
  saveRecords();
  markDirty();
  loadEntry(date);
  renderDashboard();
  showToast("記録を削除しました");
  syncToCloud("auto");
}

function markDirty() {
  syncState.dirty = true;
  syncState.lastError = "";
  saveSyncState();
  renderSyncStatus();
}

function addMealTemplate(template) {
  const calories = valueFromInput("calories") || 0;
  const protein = valueFromInput("protein") || 0;
  $("calories").value = Math.round(calories + template.calories);
  $("protein").value = Math.round((protein + template.protein) * 10) / 10;
  const memo = `${template.name} (${template.calories}kcal / P${template.protein} F${template.fat} C${template.carbs})`;
  $("meals").value = [$("meals").value.trim(), memo].filter(Boolean).join("\n");
  $("saveDockStatus").textContent = "変更あり";
  showToast(`${template.name}を追加しました`);
}

function renderMealTemplates() {
  const container = $("mealTemplateButtons");
  const templates = settings.mealTemplates || [];
  $("templateEmpty").hidden = templates.length > 0;
  container.innerHTML = templates.map((template) => `
    <button type="button" class="template-button" data-template-id="${escapeHtml(template.id)}">
      <strong>${escapeHtml(template.name)}</strong>
      <small>${formatNumber(template.calories)}kcal / P${formatNumber(template.protein, template.protein % 1 ? 1 : 0)}</small>
    </button>
  `).join("");
  container.querySelectorAll("[data-template-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const template = templates.find((item) => item.id === button.dataset.templateId);
      if (template) addMealTemplate(template);
    });
  });
}

function dashboardRecords(days) {
  return datesForDays(days).map((date) => records[date]).filter(Boolean);
}

function renderDashboard() {
  const asc = sortedRecords(false);
  const desc = sortedRecords(true);
  const today = records[todayISO()] || {};
  const latest = desc.find((record) => Number.isFinite(record.weight));
  const first = asc.find((record) => Number.isFinite(record.weight));
  const week = dashboardRecords(7);
  const weekWeights = week.filter((record) => Number.isFinite(record.weight));
  const avgWeight = average(weekWeights.map((record) => record.weight));
  const avgCalories = average(week.map((record) => record.calories));
  const avgProtein = average(week.map((record) => record.protein));

  $("currentWeight").innerHTML = latest ? `${formatNumber(latest.weight, 1)}<span>kg</span>` : `--<span>kg</span>`;
  $("latestWeightDate").textContent = latest ? `${dateLabel(latest.date, true)} の記録` : "記録待ち";
  $("targetWeightDiff").textContent = latest && Number.isFinite(settings.targetWeight)
    ? signed(latest.weight - settings.targetWeight)
    : "--";
  $("firstWeightDiff").textContent = latest && first ? signed(latest.weight - first.weight) : "--";
  $("avgWeight7").textContent = avgWeight === null ? "--" : `${formatNumber(avgWeight, 1)} kg`;

  const weekChange = weekWeights.length >= 2 ? weekWeights.at(-1).weight - weekWeights[0].weight : null;
  $("weightChange7").textContent = `7日変化 ${weekChange === null ? "--" : signed(weekChange)}`;
  $("todayCalories").textContent = Number.isFinite(today.calories) ? formatNumber(today.calories) : "--";
  $("todayProtein").textContent = Number.isFinite(today.protein) ? formatNumber(today.protein, today.protein % 1 ? 1 : 0) : "--";
  $("calorieTargetNote").textContent = Number.isFinite(settings.targetCalories) ? `目標 ${formatNumber(settings.targetCalories)} kcal` : "kcal";
  $("proteinTargetNote").textContent = Number.isFinite(settings.targetProtein) ? `目標 ${formatNumber(settings.targetProtein)} g` : "g";
  $("avgCalories7").textContent = avgCalories === null ? "-- kcal" : `${formatNumber(avgCalories)} kcal`;
  $("avgProtein7").textContent = avgProtein === null ? "P -- g" : `P ${formatNumber(avgProtein)} g`;
  $("trendInsight").textContent = buildTrendInsight(desc);

  renderCharts();
}

function buildTrendInsight(desc) {
  const weighted = desc.filter((record) => Number.isFinite(record.weight));
  if (weighted.length < 2) return "体重記録が2件以上になると、直近の変化とフラグの重なりを表示します。";
  const latest = weighted[0];
  const previous = weighted[1];
  const change = latest.weight - previous.weight;
  const recentStart = new Date(`${latest.date}T12:00:00`);
  recentStart.setDate(recentStart.getDate() - 2);
  const related = desc.filter((record) => new Date(`${record.date}T12:00:00`) >= recentStart);
  const factors = [];
  if (related.some((record) => record.swelling || /むくみ/.test(record.memo))) factors.push("むくみ");
  if (related.some((record) => record.diningOut)) factors.push("外食");
  if (related.some((record) => record.alcohol)) factors.push("飲酒");

  if (change >= 0.2 && factors.length) {
    return `直近は${signed(change)}。${factors.join("・")}の記録が重なっているため、一時的な水分変動の可能性もあります。数日単位で確認してください。`;
  }
  if (Math.abs(change) < 0.2) {
    return `直近の変化は${signed(change)}で、ほぼ横ばいです。単日の増減より7日平均を基準に見る状態です。`;
  }
  if (change < 0) return `直近は${signed(change)}。短期変動を含むため、7日平均と合わせて確認してください。`;
  return `直近は${signed(change)}。外食・飲酒・むくみの記録は見当たりません。入力漏れも含め、数日間の推移を確認してください。`;
}

function renderCharts() {
  renderSvgChart("weightChart", "weight", chartDays, 1, "weightChartSummary", "kg");
  renderSvgChart("calorieChart", "calories", chartDays, 0, "calorieChartSummary", "kcal");
  renderSvgChart("proteinChart", "protein", chartDays, 0, "proteinChartSummary", "g");
}

function renderSvgChart(svgId, key, days, digits, summaryId, unit) {
  const svg = $(svgId);
  const dates = datesForDays(days);
  const points = dates
    .map((date, index) => ({ date, index, value: records[date]?.[key] }))
    .filter((point) => Number.isFinite(point.value));
  const width = 640;
  const height = 145;
  const padX = 12;
  const padTop = 12;
  const padBottom = 22;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!points.length) {
    svg.innerHTML = `<text class="empty-label" x="${width / 2}" y="${height / 2}" text-anchor="middle">この期間の記録はありません</text>`;
    $(summaryId).textContent = "--";
    return;
  }

  const values = points.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .08, 1);
  min -= spread * .18;
  max += spread * .18;
  const x = (index) => padX + (index / Math.max(dates.length - 1, 1)) * (width - padX * 2);
  const y = (value) => padTop + ((max - value) / (max - min)) * (height - padTop - padBottom);
  const coords = points.map((point) => `${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`);
  const area = `${x(points[0].index)},${height - padBottom} ${coords.join(" ")} ${x(points.at(-1).index)},${height - padBottom}`;
  const grid = [0, .5, 1].map((ratio) => {
    const gridY = padTop + ratio * (height - padTop - padBottom);
    return `<line class="grid-line" x1="${padX}" x2="${width - padX}" y1="${gridY}" y2="${gridY}"></line>`;
  }).join("");
  const dots = points.map((point) => `<circle class="series-dot" cx="${x(point.index)}" cy="${y(point.value)}" r="${days === 7 ? 3.5 : 2.2}"></circle>`).join("");
  const labels = `
    <text class="axis-label" x="${padX}" y="${height - 5}">${dateLabel(dates[0])}</text>
    <text class="axis-label" x="${width - padX}" y="${height - 5}" text-anchor="end">${dateLabel(dates.at(-1))}</text>
  `;
  svg.innerHTML = `${grid}<polygon class="series-area" points="${area}"></polygon><polyline class="series-line" points="${coords.join(" ")}"></polyline>${dots}${labels}`;

  const first = points[0].value;
  const last = points.at(-1).value;
  const summary = key === "weight" && points.length > 1
    ? signed(last - first, digits)
    : `平均 ${formatNumber(average(values), digits)} ${unit}`;
  $(summaryId).textContent = summary;
}

function renderHistory() {
  const query = $("search").value.trim().toLowerCase();
  let list = sortedRecords(true);
  if (historyRange !== "all") {
    const allowed = new Set(datesForDays(Number(historyRange)));
    list = list.filter((record) => allowed.has(record.date));
  }
  if (query) {
    list = list.filter((record) => JSON.stringify(record).toLowerCase().includes(query));
  }
  $("historyCount").textContent = `${list.length}件`;
  $("historyList").innerHTML = list.length ? list.map(historyItemHtml).join("") : '<div class="card empty-state">該当する記録はありません。</div>';
  $("historyList").querySelectorAll("[data-edit-date]").forEach((button) => {
    button.addEventListener("click", () => switchPage("entry", { date: button.dataset.editDate }));
  });
}

function historyItemHtml(record) {
  const flags = [
    record.diningOut && "外食",
    record.alcohol && "飲酒",
    record.swelling && "むくみ",
    record.cheatDay && "チート"
  ].filter(Boolean);
  const note = [record.training, record.meals, record.memo].filter(Boolean).join(" / ");
  return `
    <button type="button" class="history-item" data-edit-date="${record.date}">
      <div class="history-top">
        <span class="history-date">${dateLabel(record.date, true)}</span>
        <span class="history-flags">${flags.map((flag) => `<span class="mini-flag">${flag}</span>`).join("")}</span>
      </div>
      <div class="history-values">
        <span><small>体重</small><strong>${Number.isFinite(record.weight) ? `${formatNumber(record.weight, 1)}kg` : "--"}</strong></span>
        <span><small>カロリー</small><strong>${Number.isFinite(record.calories) ? formatNumber(record.calories) : "--"}</strong></span>
        <span><small>タンパク質</small><strong>${Number.isFinite(record.protein) ? `${formatNumber(record.protein)}g` : "--"}</strong></span>
        <span><small>歩数</small><strong>${Number.isFinite(record.steps) ? formatNumber(record.steps) : "--"}</strong></span>
      </div>
      ${note ? `<p class="history-note">${escapeHtml(note)}</p>` : ""}
    </button>
  `;
}

function exportCsv() {
  const rows = sortedRecords(false);
  if (!rows.length) return showToast("出力する記録がありません");
  const headers = [
    "date", "weight", "calories", "protein", "water", "steps", "training", "meals", "memo",
    "diningOut", "alcohol", "swelling", "proteinCount", "cheatDay", "updatedAt"
  ];
  const cell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers.join(","), ...rows.map((record) => headers.map((key) => cell(record[key])).join(","))].join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `diet-records-${todayISO()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copySummary() {
  const rows = sortedRecords(true).slice(0, 14).reverse();
  if (!rows.length) return showToast("コピーする記録がありません");
  const lines = rows.map((record) => {
    const flags = [
      record.diningOut && "外食", record.alcohol && "飲酒", record.swelling && "むくみ", record.cheatDay && "チート日"
    ].filter(Boolean).join("・") || "なし";
    return `${record.date}: 体重 ${formatNumber(record.weight, 1)}kg / ${formatNumber(record.calories)}kcal / P ${formatNumber(record.protein)}g / 歩数 ${formatNumber(record.steps)} / フラグ ${flags} / 運動 ${record.training || "-"} / 食事 ${record.meals || "-"} / 体調 ${record.memo || "-"}`;
  });
  const text = `以下は個人のダイエット記録です。医療判断ではなく、数値の傾向、外食・飲酒・むくみとの関係、現実的な翌日の調整案を簡潔に整理してください。\n\n${lines.join("\n")}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast("AI相談用テキストをコピーしました");
  } catch {
    showToast("コピーできませんでした");
  }
}

function renderSettings() {
  setInputValue("targetWeight", settings.targetWeight);
  setInputValue("targetCalories", settings.targetCalories);
  setInputValue("targetProtein", settings.targetProtein);
  setInputValue("targetWater", settings.targetWater);
  setInputValue("gasUrl", settings.gasUrl);
  $("autoSyncEnabled").value = settings.autoSyncEnabled;
  $("autoLoadEnabled").value = settings.autoLoadEnabled;
  $("syncIntervalMinutes").value = String(settings.syncIntervalMinutes);
  $("theme").value = settings.theme;
  renderTemplateList();
  renderSyncStatus();
}

function saveTargets() {
  settings = {
    ...settings,
    targetWeight: valueFromInput("targetWeight"),
    targetCalories: valueFromInput("targetCalories"),
    targetProtein: valueFromInput("targetProtein"),
    targetWater: valueFromInput("targetWater")
  };
  saveSettings();
  markDirty();
  renderDashboard();
  showToast("目標を保存しました");
  syncToCloud("auto");
}

function addTemplate() {
  const name = $("templateName").value.trim();
  if (!name) return showToast("テンプレ名を入力してください");
  settings.mealTemplates.push({
    id: `template-${Date.now()}`,
    name,
    calories: valueFromInput("templateCalories") || 0,
    protein: valueFromInput("templateProtein") || 0,
    fat: valueFromInput("templateFat") || 0,
    carbs: valueFromInput("templateCarbs") || 0
  });
  ["templateName", "templateCalories", "templateProtein", "templateFat", "templateCarbs"].forEach((id) => { $(id).value = ""; });
  saveSettings();
  markDirty();
  renderTemplateList();
  renderMealTemplates();
  showToast("テンプレを追加しました");
}

function renderTemplateList() {
  const templates = settings.mealTemplates || [];
  $("templateList").innerHTML = templates.length ? templates.map((template) => `
    <div class="template-row">
      <div><strong>${escapeHtml(template.name)}</strong><small>${formatNumber(template.calories)}kcal / P${formatNumber(template.protein, template.protein % 1 ? 1 : 0)} F${formatNumber(template.fat, template.fat % 1 ? 1 : 0)} C${formatNumber(template.carbs, template.carbs % 1 ? 1 : 0)}</small></div>
      <button type="button" data-remove-template="${escapeHtml(template.id)}">削除</button>
    </div>
  `).join("") : '<p class="empty-copy">テンプレはまだありません。</p>';
  $("templateList").querySelectorAll("[data-remove-template]").forEach((button) => {
    button.addEventListener("click", () => {
      settings.mealTemplates = settings.mealTemplates.filter((item) => item.id !== button.dataset.removeTemplate);
      saveSettings();
      markDirty();
      renderTemplateList();
      renderMealTemplates();
    });
  });
}

function applyTheme(theme = settings.theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#111713" : "#f4f7f5";
}

function saveSyncSettings() {
  const gasUrl = $("gasUrl").value.trim();
  if (gasUrl && !/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(gasUrl)) {
    return showToast("GASのWebアプリURLを確認してください");
  }
  settings = {
    ...settings,
    gasUrl,
    autoSyncEnabled: $("autoSyncEnabled").value,
    autoLoadEnabled: $("autoLoadEnabled").value,
    syncIntervalMinutes: Number($("syncIntervalMinutes").value || 5)
  };
  saveSettings();
  setupAutoSync();
  renderSyncStatus();
  showToast(gasUrl ? "同期設定を保存しました" : "同期URLを解除しました");
}

function renderSyncStatus(override) {
  const chipDot = $("syncDot");
  const statusCard = $("syncStatus");
  const cardDot = statusCard.querySelector(".status-dot");
  chipDot.className = "status-dot";
  cardDot.className = "status-dot";

  let title = "ローカル保存のみ";
  let detail = "GAS URLは未設定です";
  let chip = "ローカル保存";
  let stateClass = "";

  if (!navigator.onLine) {
    title = "オフライン";
    detail = "記録は端末に保存済みです。オンライン復帰後に同期します。";
    chip = "オフライン";
    stateClass = "is-pending";
  } else if (syncState.lastError) {
    title = "同期を確認できません";
    detail = `ローカルには保存済みです。${syncState.lastError}`;
    chip = "同期未確認";
    stateClass = "is-error";
  } else if (syncState.dirty && settings.gasUrl) {
    title = "同期待ち";
    detail = "ローカルには保存済みです。";
    chip = "同期待ち";
    stateClass = "is-pending";
  } else if (syncState.lastConfirmedAt && settings.gasUrl) {
    title = "同期確認済み";
    detail = `最終同期 ${dateTimeLabel(syncState.lastConfirmedAt)}`;
    chip = "同期済み";
    stateClass = "is-ok";
  } else if (settings.gasUrl) {
    title = settings.autoSyncEnabled === "off" ? "手動同期" : "自動同期ON";
    detail = settings.autoSyncEnabled === "off" ? "自動同期はOFFです" : `${settings.syncIntervalMinutes}分間隔で確認します`;
    chip = settings.autoSyncEnabled === "off" ? "手動同期" : "同期設定済み";
    stateClass = "is-ok";
  }

  if (override) {
    title = override.title;
    detail = override.detail || detail;
    chip = override.chip || title;
    stateClass = override.stateClass || "is-pending";
  }
  if (stateClass) {
    chipDot.classList.add(stateClass);
    cardDot.classList.add(stateClass);
  }
  $("syncChipText").textContent = chip;
  statusCard.querySelector("strong").textContent = title;
  statusCard.querySelector("small").textContent = detail;
}

function cloudSettings(syncToken) {
  const { gasUrl, ...shareable } = settings;
  return { ...shareable, syncToken };
}

function syncToCloud(mode = "manual") {
  if (!settings.gasUrl) {
    renderSyncStatus();
    if (mode === "manual") showToast("GAS URLが未設定です");
    return;
  }
  if (!navigator.onLine) {
    syncState.lastError = "現在オフラインです。";
    saveSyncState();
    renderSyncStatus();
    if (mode === "manual") showToast("オフラインのため同期待ちです");
    return;
  }
  if (settings.autoSyncEnabled === "off" && mode !== "manual") return;
  if (mode === "interval" && !syncState.dirty) return;
  if (syncInFlight) return;

  syncInFlight = true;
  const syncToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  syncState.lastAttemptAt = new Date().toISOString();
  syncState.lastError = "";
  saveSyncState();
  renderSyncStatus({ title: "Googleへ送信中", detail: "ローカル保存は完了しています", chip: "送信中" });

  fetch(settings.gasUrl, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      app: "diet-tracker",
      version: APP_VERSION,
      savedAt: new Date().toISOString(),
      settings: cloudSettings(syncToken),
      records
    })
  })
    .then(() => new Promise((resolve) => setTimeout(resolve, 900)))
    .then(() => readCloud())
    .then((data) => {
      if (String(data.settings?.syncToken || "") !== syncToken) {
        throw new Error("送信後の保存確認ができませんでした。");
      }
      syncState.dirty = false;
      syncState.lastConfirmedAt = new Date().toISOString();
      syncState.lastError = "";
      saveSyncState();
      renderSyncStatus();
      if (mode === "manual") showToast("同期を確認しました");
    })
    .catch((error) => {
      syncState.lastError = error.message || "通信に失敗しました。";
      saveSyncState();
      renderSyncStatus();
      if (mode === "manual") showToast("ローカル保存済み・同期は未確認です");
    })
    .finally(() => { syncInFlight = false; });
}

function readCloud() {
  return new Promise((resolve, reject) => {
    const callbackName = `dietCloudCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("クラウド読込がタイムアウトしました。")), 12000);
    function finish(error, data) {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      error ? reject(error) : resolve(data);
    }
    window[callbackName] = (data) => {
      if (!data || data.ok === false) finish(new Error(data?.error || "クラウド読込に失敗しました。"));
      else finish(null, data);
    };
    script.onerror = () => finish(new Error("GAS URLまたは公開設定を確認してください。"));
    const separator = settings.gasUrl.includes("?") ? "&" : "?";
    script.src = `${settings.gasUrl}${separator}action=load&callback=${callbackName}&t=${Date.now()}`;
    document.body.appendChild(script);
  });
}

function mergeRecords(localRecords, remoteRecords) {
  const merged = { ...localRecords };
  Object.entries(migrateRecords(remoteRecords)).forEach(([date, remote]) => {
    const local = merged[date];
    if (!local) {
      merged[date] = remote;
      return;
    }
    const localTime = Date.parse(local.updatedAt || "") || 0;
    const remoteTime = Date.parse(remote.updatedAt || "") || 0;
    if (remoteTime > localTime) merged[date] = remote;
  });
  return merged;
}

function loadFromCloud(askConfirm = true) {
  if (!settings.gasUrl) return showToast("GAS URLが未設定です");
  if (!navigator.onLine) return showToast("オフラインでは読み込めません");
  if (askConfirm && !window.confirm("クラウドとローカルの記録を日付ごとに統合しますか？新しい更新日時の記録を優先します。")) return;
  renderSyncStatus({ title: "クラウド読込中", detail: "ローカルデータは削除しません", chip: "読込中" });
  readCloud()
    .then((data) => {
      records = mergeRecords(records, data.records || {});
      const remoteSettings = migrateSettings({ ...settings, ...(data.settings || {}), gasUrl: settings.gasUrl });
      delete remoteSettings.syncToken;
      settings = remoteSettings;
      saveRecords();
      saveSettings();
      syncState.lastError = "";
      saveSyncState();
      applyTheme();
      loadEntry($("date").value || todayISO());
      renderMealTemplates();
      renderDashboard();
      renderHistory();
      renderSettings();
      showToast("クラウドの記録を統合しました");
    })
    .catch((error) => {
      syncState.lastError = error.message;
      saveSyncState();
      renderSyncStatus();
      showToast("クラウド読込に失敗しました");
    });
}

function setupAutoSync() {
  clearInterval(syncTimer);
  if (!settings.gasUrl || settings.autoSyncEnabled === "off") return;
  syncTimer = setInterval(() => syncToCloud("interval"), Math.max(1, settings.syncIntervalMinutes) * 60 * 1000);
}

function resetLocalData() {
  if (!window.confirm("すべてのローカル記録と設定を削除しますか？この操作は元に戻せません。")) return;
  localStorage.removeItem(RECORDS_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(SYNC_KEY);
  records = {};
  settings = migrateSettings({});
  syncState = { dirty: false, lastAttemptAt: "", lastConfirmedAt: "", lastError: "" };
  saveSettings();
  applyTheme();
  loadEntry(todayISO());
  renderMealTemplates();
  renderDashboard();
  renderSettings();
  showToast("ローカルデータを削除しました");
}

function bindEvents() {
  document.querySelectorAll(".bottom-nav button").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
  $("syncChip").addEventListener("click", () => {
    switchPage("settings");
    setTimeout(() => $("syncSettings").scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  });
  document.querySelectorAll("[data-open-settings]").forEach((button) => button.addEventListener("click", () => {
    switchPage("settings");
    setTimeout(() => $("templateSettings").scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }));
  $("entryForm").addEventListener("submit", saveEntry);
  $("date").addEventListener("change", (event) => loadEntry(event.target.value));
  $("deleteBtn").addEventListener("click", deleteEntry);
  $("entryForm").addEventListener("input", () => { $("saveDockStatus").textContent = "変更あり"; });
  $("search").addEventListener("input", renderHistory);
  $("exportBtn").addEventListener("click", exportCsv);
  $("copySummaryBtn").addEventListener("click", copySummary);
  $("saveTargetsBtn").addEventListener("click", saveTargets);
  $("addTemplateBtn").addEventListener("click", addTemplate);
  $("saveSyncBtn").addEventListener("click", saveSyncSettings);
  $("syncNowBtn").addEventListener("click", () => syncToCloud("manual"));
  $("loadCloudBtn").addEventListener("click", () => loadFromCloud(true));
  $("resetBtn").addEventListener("click", resetLocalData);
  $("theme").addEventListener("change", (event) => {
    settings.theme = event.target.value;
    saveSettings();
    applyTheme();
  });
  $("chartRange").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    chartDays = Number(button.dataset.range);
    $("chartRange").querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderCharts();
  });
  $("historyRange").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    historyRange = button.dataset.range;
    $("historyRange").querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderHistory();
  });
  window.addEventListener("online", () => {
    renderSyncStatus();
    if (syncState.dirty) syncToCloud("interval");
  });
  window.addEventListener("offline", renderSyncStatus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && syncState.dirty) syncToCloud("auto");
  });
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");
  const handleColorSchemeChange = () => {
    if (settings.theme === "system") applyTheme();
  };
  if (colorScheme.addEventListener) colorScheme.addEventListener("change", handleColorSchemeChange);
  else colorScheme.addListener(handleColorSchemeChange);
}

function initialize() {
  saveRecords();
  saveSettings();
  applyTheme();
  bindEvents();
  loadEntry(todayISO());
  renderMealTemplates();
  renderDashboard();
  renderSettings();
  renderSyncStatus();
  setupAutoSync();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
  if (settings.gasUrl && settings.autoLoadEnabled === "on" && navigator.onLine) {
    setTimeout(() => loadFromCloud(false), 700);
  }
}

initialize();
