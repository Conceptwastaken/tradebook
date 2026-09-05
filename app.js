// ============================================================
// APP.JS — pairs with the new dashboard.html served at
// app.tradebook.com.ng. Assumes the person is already
// authenticated (auth happens on tradebook.com.ng/onboarding.html).
// If no session is found here, bounce back to auth.
// ============================================================

// >>> CHANGE THIS to your actual auth-page URL if different <<<
const AUTH_URL = "https://tradebook.com.ng/onboarding.html";

const SUPABASE_URL = "https://ekgsklyozoftzrpzqsqg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable__qcdvIHMqdNS67Awe8D2rg_ORrH0ObY";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const THEME_KEY = "tradebook_theme_v1";

// Curated pair list for the picker. Grouped for the popup.
const PAIR_GROUPS = [
  {
    label: "Forex — Majors",
    pairs: [
      ["EURUSD", "Euro / USD"],
      ["GBPUSD", "Pound / USD"],
      ["USDJPY", "USD / Yen"],
      ["USDCHF", "USD / Franc"],
      ["USDCAD", "USD / CAD"],
      ["AUDUSD", "Aussie / USD"],
      ["NZDUSD", "Kiwi / USD"],
    ],
  },
  {
    label: "Forex — Crosses",
    pairs: [
      ["EURGBP", "Euro / Pound"],
      ["EURJPY", "Euro / Yen"],
      ["GBPJPY", "Pound / Yen"],
      ["EURAUD", "Euro / Aussie"],
      ["GBPAUD", "Pound / Aussie"],
      ["AUDJPY", "Aussie / Yen"],
      ["CHFJPY", "Franc / Yen"],
    ],
  },
  {
    label: "Metals & Energy",
    pairs: [
      ["XAUUSD", "Gold"],
      ["XAGUSD", "Silver"],
      ["USOIL", "Crude Oil (WTI)"],
      ["UKOIL", "Crude Oil (Brent)"],
    ],
  },
  {
    label: "Crypto",
    pairs: [
      ["BTCUSD", "Bitcoin"],
      ["ETHUSD", "Ethereum"],
      ["SOLUSD", "Solana"],
      ["XRPUSD", "XRP"],
      ["BNBUSD", "BNB"],
    ],
  },
  {
    label: "Indices",
    pairs: [
      ["US30", "Dow Jones"],
      ["NAS100", "Nasdaq 100"],
      ["SPX500", "S&P 500"],
      ["GER40", "DAX 40"],
      ["UK100", "FTSE 100"],
    ],
  },
];

let currentUser = null;
let profile = null;
let ongoingTrades = [];
let closedTrades = [];
let ongoingLayoutCompact = localStorage.getItem("tb_ongoingCompact") === "1";
function toggleOngoingLayout() {
  ongoingLayoutCompact = !ongoingLayoutCompact;
  localStorage.setItem("tb_ongoingCompact", ongoingLayoutCompact ? "1" : "0");
  renderMain();
}
let currentTab = "home";
let currentSubTab = "closed";
let perfGranularity = "month";
let perfRange = "1M";
let perfCalendarMonth = (() => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
})();
let selectedCalendarDateKey = null;
let closingTradeId = null;
let editingTradeId = null;
let editingClosedTradeId = null;
let openClosedDropdownId = null;
let closedEditSyncing = false;
let lastEditedClosedField = null;
let formDirection = "Buy";
let editFormDirection = "Buy";
let addRiskMode = "percent";
let accountEditOpen = false;
let pendingAvatarFile = null;
let pendingAvatarPreviewUrl = null;

// ---------- money / trading math ----------
function dollarsPerPriceUnit({ riskAmount, entry, slPrice }) {
  const dist = Math.abs(entry - slPrice);
  if (!dist) return null;
  return riskAmount / dist;
}

function computeTradePlan({
  entry,
  direction,
  slPrice,
  tpPrice,
  riskPercent,
  balance,
}) {
  const riskAmount = balance * (riskPercent / 100);
  const dpu = dollarsPerPriceUnit({ riskAmount, entry, slPrice });
  if (dpu === null) return null;
  const rewardDist = Math.abs(tpPrice - entry);
  const riskDist = Math.abs(entry - slPrice);
  const rr = riskDist ? rewardDist / riskDist : 0;
  return {
    riskAmount,
    rr,
    potentialProfit: riskAmount * rr,
    dollarsPerUnit: dpu,
  };
}

function pnlFromExitPrice({ entry, exit, direction, dollarsPerUnit }) {
  const dir = direction === "Buy" ? 1 : -1;
  return (exit - entry) * dir * dollarsPerUnit;
}

function exitPriceFromPnl({ entry, direction, dollarsPerUnit, pnl }) {
  const dir = direction === "Buy" ? 1 : -1;
  return entry + (pnl / dollarsPerUnit) * dir;
}

// ------------------------------------------------------------
// Broker-math risk cross-check (Exness & XM standard specs)
// ------------------------------------------------------------
const ACCOUNT_TYPE_KEY = "tb_accountType";
function getAccountType() {
  return localStorage.getItem(ACCOUNT_TYPE_KEY) === "cent"
    ? "cent"
    : "standard";
}
function setAccountType(type) {
  localStorage.setItem(ACCOUNT_TYPE_KEY, type === "cent" ? "cent" : "standard");
}
const CRYPTO_PAIRS = new Set(
  (PAIR_GROUPS.find((g) => /crypto/i.test(g.label))?.pairs || []).map(
    ([symbol]) => symbol,
  ),
);
const INDEX_PAIRS = new Set(
  (PAIR_GROUPS.find((g) => /indices/i.test(g.label))?.pairs || []).map(
    ([symbol]) => symbol,
  ),
);
function contractSizeForPair(pair) {
  const p = (pair || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!p) return null;
  if (CRYPTO_PAIRS.has(p) || INDEX_PAIRS.has(p)) return null;
  if (p.includes("XAU") || p === "GOLD") return 100;
  if (p.includes("XAG") || p === "SILVER") return 5000;
  if (/^[A-Z]{6}$/.test(p)) return 100000;
  return null;
}

// ------------------------------------------------------------
// Live FX rates
// ------------------------------------------------------------
let fxRates = null;
let fxRatesFetchedAt = 0;
let fxRatesLoadFailed = false;
const FX_REFRESH_MS = 10 * 60 * 1000;
const FX_RETRY_AFTER_FAIL_MS = 15 * 1000;

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function notifyFxRatesChanged() {
  try {
    if (typeof syncRiskFromLot === "function") syncRiskFromLot();
  } catch (e) {}
  try {
    if (typeof updateEditPreview === "function") updateEditPreview();
  } catch (e) {}
}

function applyFxRates(ratesObj) {
  const normalized = { USD: 1 };
  for (const [code, rate] of Object.entries(ratesObj || {})) {
    if (typeof rate === "number" && rate > 0)
      normalized[code.toUpperCase()] = rate;
  }
  fxRates = normalized;
  fxRatesFetchedAt = Date.now();
  fxRatesLoadFailed = false;
  notifyFxRatesChanged();
}

async function refreshFxRates() {
  const primary = await fetchJson(
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  );
  if (primary && primary.usd) return applyFxRates(primary.usd);

  const mirror = await fetchJson(
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
  );
  if (mirror && mirror.usd) return applyFxRates(mirror.usd);

  const legacy = await fetchJson(
    "https://api.frankfurter.dev/v1/latest?base=USD",
  );
  if (legacy && legacy.rates) return applyFxRates(legacy.rates);

  fxRatesLoadFailed = true;
  notifyFxRatesChanged();
  setTimeout(refreshFxRates, FX_RETRY_AFTER_FAIL_MS);
}

function fxRateFor(currencyCode) {
  if (!fxRates) return null;
  const rate = fxRates[currencyCode];
  return typeof rate === "number" && rate > 0 ? rate : null;
}

function liveRateWaitState({ pair, entry, slPrice, lotSize }) {
  const p = (pair || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!p || !entry || !slPrice || !lotSize || entry === slPrice) return null;
  if (CRYPTO_PAIRS.has(p) || INDEX_PAIRS.has(p)) return null;
  const isMetal =
    p.includes("XAU") || p === "GOLD" || p.includes("XAG") || p === "SILVER";
  if (isMetal || !/^[A-Z]{6}$/.test(p)) return null;
  const base = p.slice(0, 3);
  const quote = p.slice(3, 6);
  if (quote === "USD" || base === "USD") return null;
  if (fxRateFor(quote) !== null) return null;
  return fxRatesLoadFailed ? "failed" : "loading";
}

function estimateRiskFromLot({ pair, entry, slPrice, lotSize }) {
  const contractSize = contractSizeForPair(pair);
  if (!contractSize || !lotSize || !entry || !slPrice || entry === slPrice)
    return null;
  const centDivisor = getAccountType() === "cent" ? 100 : 1;
  const priceDistance = Math.abs(entry - slPrice);
  const rawRisk = priceDistance * lotSize * (contractSize / centDivisor);

  const p = (pair || "").toUpperCase().replace(/[^A-Z]/g, "");
  const isMetal =
    p.includes("XAU") || p === "GOLD" || p.includes("XAG") || p === "SILVER";
  if (isMetal) return rawRisk;

  if (/^[A-Z]{6}$/.test(p)) {
    const base = p.slice(0, 3);
    const quote = p.slice(3, 6);
    if (quote === "USD") return rawRisk;

    const liveRate = fxRateFor(quote);
    if (liveRate !== null) return rawRisk / liveRate;

    if (base === "USD") return rawRisk / entry;

    return null;
  }

  return null;
}

function roundDown3(n) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return n;
  return parseFloat(Number(n).toPrecision(12));
}

function decimalsOf(n) {
  if (n == null || Number.isNaN(Number(n))) return 0;
  const s = Number(n).toString();
  if (s.includes("e") || s.includes("E")) return 8;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function roundToTradePrecision(trade, price) {
  if (price == null || Number.isNaN(price)) return price;
  const decimals = Math.max(
    decimalsOf(trade.entry),
    decimalsOf(trade.slPrice),
    decimalsOf(trade.tpPrice),
    2,
  );
  const factor = Math.pow(10, decimals);
  return roundDown3(Math.round(price * factor) / factor);
}

const RISK_CAUTION_PCT = 10;
const RISK_DANGER_PCT = 25;
function riskLevelInfo(riskPercent) {
  if (riskPercent >= RISK_DANGER_PCT)
    return {
      color: "var(--sell)",
      label: `⚠ High risk — ${riskPercent.toFixed(1)}% of balance on one trade`,
    };
  if (riskPercent >= RISK_CAUTION_PCT)
    return {
      color: "#d9a02a",
      label: `Elevated risk — ${riskPercent.toFixed(1)}% of balance`,
    };
  return null;
}

function fmtMoney(n) {
  const num = Number(n);
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtPrice(n) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return "—";
  return parseFloat(Number(n).toPrecision(12)).toString();
}
function periodKey(iso, granularity) {
  const d = new Date(iso);
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    day = String(d.getDate()).padStart(2, "0");
  if (granularity === "year") return `${y}`;
  if (granularity === "month") return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}
function periodLabel(key, granularity) {
  if (granularity === "year") return key;
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
  }
  return new Date(key + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function friendlySaveError(error, fallback) {
  const msg = (error && error.message) || "";
  if (msg.includes("trades_direction_check")) {
    return "Please choose Buy or Sell before saving this trade.";
  }
  return fallback + msg;
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
function greetingText() {
  const h = new Date().getHours();
  const period = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const name = profile && profile.name ? profile.name.split(" ")[0] : "there";
  return `Good ${period}, <span>${escapeHtml(name)}</span>`;
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute(
    "data-theme",
    theme === "dark" ? "dark" : "light",
  );
}
function loadTheme() {
  const t = localStorage.getItem(THEME_KEY) || "light";
  applyTheme(t);
  return t;
}
function setTheme(t) {
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}

function showOnly(id) {
  ["loadingScreen", "setupScreen", "appShell"].forEach((s) => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}
function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "Working…" : label;
}

// ---------- boot ----------
async function boot() {
  try {
    await bootInner();
  } catch (err) {
    console.error("Boot failed:", err);
    window.location.href = AUTH_URL;
  }
}

async function bootInner() {
  loadTheme();
  showOnly("loadingScreen");

  refreshFxRates();
  setInterval(refreshFxRates, FX_REFRESH_MS);

  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    // Not authenticated on this domain — send back to auth.
    window.location.href = AUTH_URL;
    return;
  }
  const { data: freshUser, error: freshUserErr } = await sb.auth.getUser();
  currentUser = !freshUserErr && freshUser.user ? freshUser.user : session.user;

  await loadProfileAndData();
}

async function loadProfileAndData() {
  let { data: prof, error: profErr } = await sb
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (profErr && profErr.code === "PGRST116") {
    const meta = currentUser.user_metadata || {};
    const derivedName =
      meta.name || meta.full_name || (currentUser.email || "").split("@")[0];
    const { data: created, error: createErr } = await sb
      .from("profiles")
      .insert({
        id: currentUser.id,
        name: derivedName,
        email: currentUser.email,
        onboarded: false,
      })
      .select()
      .single();
    if (createErr) {
      // Profile couldn't be created — bounce back to auth rather than
      // showing a dead dashboard with no profile.
      window.location.href = AUTH_URL;
      return;
    }
    prof = created;
    profErr = null;
  }

  if (profErr || !prof) {
    window.location.href = AUTH_URL;
    return;
  }
  profile = prof;
  if (!profile.onboarded) {
    showOnly("setupScreen");
    return;
  }
  await loadTrades();
  showOnly("appShell");
  currentTab = "home";
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === "home"));
  renderMain();
}

async function loadTrades() {
  const { data: ongoing } = await sb
    .from("trades")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("status", "ongoing")
    .order("opened_at", { ascending: false });
  const { data: closed } = await sb
    .from("trades")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("status", "closed")
    .order("closed_at", { ascending: false });
  ongoingTrades = (ongoing || []).map(normalizeTrade);
  closedTrades = (closed || []).map(normalizeTrade);
}

function normalizeTrade(t) {
  return {
    ...t,
    entry: Number(t.entry),
    exit: t.exit != null ? Number(t.exit) : null,
    lotSize: Number(t.lot_size),
    riskPercent: Number(t.risk_percent),
    rr: Number(t.rr),
    slPrice: t.sl_price != null ? Number(t.sl_price) : null,
    tpPrice: t.tp_price != null ? Number(t.tp_price) : null,
    riskAmount: t.risk_amount != null ? Number(t.risk_amount) : null,
    potentialProfit:
      t.potential_profit != null ? Number(t.potential_profit) : null,
    pnl: t.pnl != null ? Number(t.pnl) : null,
    balanceBefore: t.balance_before != null ? Number(t.balance_before) : null,
    balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
    moodTags: Array.isArray(t.mood_tags) ? t.mood_tags : [],
    openedAt: t.opened_at,
    closedAt: t.closed_at,
    result:
      t.pnl == null
        ? null
        : Number(t.pnl) > 0
          ? "Win"
          : Number(t.pnl) < 0
            ? "Loss"
            : "Breakeven",
  };
}

// ---------- balance setup (first-time, shown here on the app domain) ----------
document.getElementById("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bal = parseFloat(document.getElementById("setupBalance").value);
  const errEl = document.getElementById("setupError");
  const btn = document.getElementById("setupSubmitBtn");
  if (!bal || bal <= 0) {
    errEl.textContent = "Enter a starting balance above zero.";
    return;
  }
  setBusy(btn, true);

  const { data, error } = await sb
    .from("profiles")
    .update({ balance: bal, initial_balance: bal, onboarded: true })
    .eq("id", currentUser.id)
    .select()
    .single();

  setBusy(btn, false, "Start journal");
  if (error) {
    errEl.textContent = "Could not save. " + error.message;
    return;
  }
  profile = data;
  ongoingTrades = [];
  closedTrades = [];
  showOnly("appShell");
  renderMain();
  if (!localStorage.getItem(TOUR_KEY)) {
    setTimeout(() => startTour(), 400);
  }
});

// ---------- nav ----------
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    document
      .querySelectorAll(".nav-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderMain();
  });
});

document.getElementById("topbarAvatarBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dd = document.getElementById("profileMenuDropdown");
  const opening = dd.classList.contains("hidden");
  if (!opening) {
    dd.classList.add("hidden");
    return;
  }
  document.getElementById("profileMenuAvatarWrap").innerHTML = avatarHtml();
  document.getElementById("profileMenuName").textContent = profile.name;
  document.getElementById("profileMenuEmail").textContent = profile.email;
  const currentTheme = localStorage.getItem(THEME_KEY) || "light";
  document.getElementById("profileMenuThemeBtn").textContent =
    currentTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  dd.classList.remove("hidden");
});

document.addEventListener("click", (e) => {
  const dd = document.getElementById("profileMenuDropdown");
  if (dd.classList.contains("hidden")) return;
  if (dd.contains(e.target) || e.target.closest("#topbarAvatarBtn")) return;
  dd.classList.add("hidden");
});

function closeProfileDropdown() {
  document.getElementById("profileMenuDropdown").classList.add("hidden");
}

document.getElementById("profileMenuEditBtn").addEventListener("click", () => {
  closeProfileDropdown();
  currentTab = "settings";
  accountEditOpen = true;
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === "settings"));
  renderMain();
});

document.getElementById("profileMenuThemeBtn").addEventListener("click", () => {
  const next =
    (localStorage.getItem(THEME_KEY) || "light") === "dark" ? "light" : "dark";
  setTheme(next);
  closeProfileDropdown();
  if (currentTab === "settings") renderMain();
});

document
  .getElementById("profileMenuExportBtn")
  .addEventListener("click", () => {
    closeProfileDropdown();
    exportData();
  });

document
  .getElementById("profileMenuSettingsBtn")
  .addEventListener("click", () => {
    closeProfileDropdown();
    currentTab = "settings";
    accountEditOpen = false;
    document
      .querySelectorAll(".nav-btn")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.tab === "settings"),
      );
    renderMain();
  });

document
  .getElementById("profileMenuLogoutBtn")
  .addEventListener("click", async () => {
    closeProfileDropdown();
    await sb.auth.signOut();
    currentUser = null;
    profile = null;
    window.location.href = AUTH_URL;
  });

// ============================================================
// PAIR PICKER
// ============================================================
function flatMatches(query) {
  const q = query.trim().toUpperCase();
  const all = [];
  PAIR_GROUPS.forEach((group) => {
    group.pairs.forEach(([sym, desc]) =>
      all.push({ sym, desc, group: group.label }),
    );
  });
  if (!q) return all;
  return all.filter(
    ({ sym, desc }) => sym.includes(q) || desc.toUpperCase().includes(q),
  );
}

function setupPairDropdown(inputId, dropdownId, onPreviewUpdate) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let kbIndex = -1;
  let currentMatches = [];

  function render(query) {
    currentMatches = flatMatches(query);
    kbIndex = -1;
    if (!currentMatches.length) {
      dropdown.innerHTML = `<div class="pair-custom-row">No match — you can still use "${escapeHtml(query.trim().toUpperCase() || "your own symbol")}" as a custom pair.</div>`;
    } else if (!query.trim()) {
      let html = "";
      let lastGroup = null;
      currentMatches.forEach(({ sym, desc, group }, i) => {
        if (group !== lastGroup) {
          html += `<div class="pair-group-label">${escapeHtml(group)}</div>`;
          lastGroup = group;
        }
        html += `<div class="pair-option" data-i="${i}"><span class="sym">${escapeHtml(sym)}</span><span class="desc">${escapeHtml(desc)}</span></div>`;
      });
      dropdown.innerHTML = html;
    } else {
      dropdown.innerHTML = currentMatches
        .map(
          ({ sym, desc }, i) =>
            `<div class="pair-option" data-i="${i}"><span class="sym">${escapeHtml(sym)}</span><span class="desc">${escapeHtml(desc)}</span></div>`,
        )
        .join("");
    }
    dropdown.querySelectorAll(".pair-option").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const m = currentMatches[Number(el.dataset.i)];
        if (m) selectValue(m.sym);
      });
    });
    dropdown.classList.remove("hidden");
  }

  function selectValue(sym) {
    input.value = sym;
    dropdown.classList.add("hidden");
    onPreviewUpdate();
  }

  function updateKbHighlight() {
    dropdown.querySelectorAll(".pair-option").forEach((el, i) => {
      el.classList.toggle("kb-active", i === kbIndex);
    });
    const active = dropdown.querySelector(".pair-option.kb-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("input", () => {
    render(input.value);
    onPreviewUpdate();
  });
  input.addEventListener("keydown", (e) => {
    if (dropdown.classList.contains("hidden") || !currentMatches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      kbIndex = Math.min(kbIndex + 1, currentMatches.length - 1);
      updateKbHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      kbIndex = Math.max(kbIndex - 1, 0);
      updateKbHighlight();
    } else if (e.key === "Enter" && kbIndex >= 0) {
      e.preventDefault();
      selectValue(currentMatches[kbIndex].sym);
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden");
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => dropdown.classList.add("hidden"), 100);
  });
}

setupPairDropdown("f_pair", "f_pairDropdown", updateAddPreview);
setupPairDropdown("e_pair", "e_pairDropdown", updateEditPreview);
setupPairDropdown("c_pair", "c_pairDropdown", updateAddClosedPreview);

// ============================================================
// PRE-TRADE CHECKLIST
// ============================================================
document.getElementById("checklistToggle").addEventListener("click", () => {
  document.getElementById("checklistToggle").classList.toggle("open");
  document.getElementById("checklistItems").classList.toggle("open");
});
function readChecklist() {
  return Array.from(
    document.querySelectorAll("#checklistItems input:checked"),
  ).map((el) => el.value);
}

// ============================================================
// main render
// ============================================================
function renderMain() {
  const topbarAvatarWrap = document.getElementById("topbarAvatarWrap");
  if (topbarAvatarWrap) topbarAvatarWrap.innerHTML = avatarHtml();

  const content = document.getElementById("mainContent");
  if (currentTab === "home") content.innerHTML = renderHome();
  else if (currentTab === "trades") content.innerHTML = renderTrades();
  else if (currentTab === "performance")
    content.innerHTML = renderPerformance();
  else if (currentTab === "settings") content.innerHTML = renderSettings();

  attachContentListeners();
  if (currentTab === "performance") drawPerfChart();
}

function emptyStateHtml({ icon, title, sub, ctaLabel, ctaId }) {
  return `<div class="empty-state">
      ${icon ? `<div class="empty-state-icon">${icon}</div>` : ""}
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="empty-state-sub">${escapeHtml(sub)}</div>` : ""}
      ${ctaLabel ? `<button type="button" class="btn-outline" id="${ctaId}">${escapeHtml(ctaLabel)}</button>` : ""}
    </div>`;
}
const ICON_CANDLES = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3v4M7 7h0M7 7v10M7 17h0M7 17v4M17 3v7M17 10h0M17 10v4M17 14h0M17 14v7"/><rect x="5" y="7" width="4" height="6" rx="1"/><rect x="15" y="10" width="4" height="4" rx="1"/></svg>`;
const ICON_CHART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17l6-6 4 4 8-8M21 7v6h-6"/></svg>`;

function renderStatCard(label, value) {
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value display">${value}</div></div>`;
}

const ICON_LAYOUT_TOGGLE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
function layoutToggleBtnHtml(id) {
  return `<button type="button" class="layout-toggle-btn" id="${id}" aria-pressed="${ongoingLayoutCompact}" aria-label="${ongoingLayoutCompact ? "Switch to full-size cards" : "Switch to compact 2-column cards"}">${ICON_LAYOUT_TOGGLE}</button>`;
}

function directionTag(direction) {
  const isBuy = direction === "Buy";
  return `<span class="tag ${isBuy ? "tag-buy" : "tag-sell"}">${isBuy ? "BUY" : "SELL"}</span>`;
}

function ongoingCardHtml(t) {
  return `<div class="card">
      <div class="card-head">
        <div><span class="pair-name">${escapeHtml(t.pair)}</span>${directionTag(t.direction)}</div>
        <div class="card-actions">
          <button class="btn-icon-small edit-trade-btn" data-id="${t.id}" aria-label="Edit ${escapeHtml(t.pair)} trade">Edit</button>
          <button class="btn-icon-small danger delete-trade-btn" data-id="${t.id}" aria-label="Delete ${escapeHtml(t.pair)} trade">Delete</button>
        </div>
      </div>
      <div class="mini-grid">
        <div><div class="mini-label">Entry</div><div>${fmtPrice(t.entry)}</div></div>
        <div><div class="mini-label">SL</div><div style="color:var(--sell)">${fmtPrice(t.slPrice)}</div></div>
        <div><div class="mini-label">TP</div><div>${fmtPrice(t.tpPrice)}</div></div>
        <div><div class="mini-label">Risk</div><div style="color:var(--sell)">${fmtMoney(t.riskAmount)}</div></div>
        <div><div class="mini-label">Reward</div><div>${fmtMoney(t.potentialProfit)}</div></div>
        <div><div class="mini-label">Lot</div><div>${t.lotSize}</div></div>
      </div>
      ${t.notes ? `<div class="card-notes">${escapeHtml(t.notes)}</div>` : ""}
      <button class="btn-small close-trade-btn close-trade-cta" data-id="${t.id}">Close trade</button>
    </div>`;
}

function ongoingCardSwipeHtml(t) {
  return `<div class="swipe-wrap" data-swipe-id="${t.id}">
      <div class="swipe-actions">
        <button type="button" class="swipe-edit-btn edit-trade-btn" data-id="${t.id}" aria-label="Edit ${escapeHtml(t.pair)} trade">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Edit
        </button>
        <button type="button" class="swipe-delete-btn delete-trade-btn" data-id="${t.id}" aria-label="Delete ${escapeHtml(t.pair)} trade">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          Delete
        </button>
      </div>
      <div class="swipe-card-inner">${ongoingCardHtml(t)}</div>
    </div>`;
}

function weeklyRecapStats() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const trades = closedTrades.filter((t) => new Date(t.closedAt) >= cutoff);
  const stats = computeStats(trades);
  let topPair = "—";
  if (trades.length) {
    const counts = {};
    trades.forEach((t) => {
      counts[t.pair] = (counts[t.pair] || 0) + 1;
    });
    topPair = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return { trades, stats, topPair };
}

function streakStats() {
  const sorted = [...closedTrades].sort(
    (a, b) => new Date(b.closedAt) - new Date(a.closedAt),
  );
  let streakType = null;
  let streakCount = 0;
  for (const t of sorted) {
    const type = t.pnl > 0 ? "win" : t.pnl < 0 ? "loss" : null;
    if (type === null) break;
    if (streakType === null) {
      streakType = type;
      streakCount = 1;
    } else if (type === streakType) {
      streakCount++;
    } else {
      break;
    }
  }
  let daysSinceLastTrade = null;
  if (sorted.length) {
    const lastDay = new Date(sorted[0].closedAt);
    lastDay.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    daysSinceLastTrade = Math.round((today - lastDay) / 86400000);
  }
  return { streakType, streakCount, daysSinceLastTrade };
}

function streakCardHtml() {
  const s = streakStats();
  if (!s.streakType) return "";
  return `
    <div class="streak-card">
      <div class="streak-card-item">
        <div class="streak-card-value" style="color:${s.streakType === "win" ? "var(--win)" : "var(--sell)"}">${s.streakCount}-${s.streakType} streak</div>
        <div class="streak-card-sub">${s.streakType === "win" ? "Keep it going" : "Snap it with your next trade"}</div>
      </div>
      ${
        s.daysSinceLastTrade !== null
          ? `<div class="streak-card-divider"></div>
             <div class="streak-card-item">
               <div class="streak-card-value">${s.daysSinceLastTrade === 0 ? "Today" : s.daysSinceLastTrade + "d"}</div>
               <div class="streak-card-sub">since last logged trade</div>
             </div>`
          : ""
      }
    </div>`;
}

const ICON_X_SQUARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function renderHome() {
  const allStats = computeStats(closedTrades);
  const totalReturn =
    profile.initial_balance > 0
      ? ((profile.balance - profile.initial_balance) /
          profile.initial_balance) *
        100
      : 0;
  const totalPnl = profile.balance - profile.initial_balance;
  const recap = weeklyRecapStats();

  let html = `<div class="home-header-row">
      <div class="greeting">${greetingText()}</div>
      <div class="home-actions-col">
        <div class="btn-row">
          <button class="btn-primary" id="openAddBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 5v14M5 12h14"/></svg>
            Add new trade
          </button>
          <button class="btn-outline" id="openAddClosedBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"><path d="M20 6L9 17l-5-5"/></svg>
            Add closed trade
          </button>
        </div>
      </div>
    </div>

    <div class="hero-pnl-card">
      <div class="hero-pnl-label">Current balance</div>
      <div class="hero-pnl-value">${fmtMoney(profile.balance)}</div>
      <div class="hero-pnl-split">
        <div class="hero-pnl-split-item">
          <div class="hero-pnl-split-label">Total P&amp;L</div>
          <div class="hero-pnl-split-value" style="color:${totalPnl < 0 ? "var(--sell)" : "var(--text)"}">${totalPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(totalPnl))}</div>
        </div>
        <div class="hero-pnl-split-item align-right">
          <div class="hero-pnl-split-label">All time</div>
          <div class="hero-pnl-split-value" style="color:${totalReturn < 0 ? "var(--sell)" : "var(--text-dim)"}">${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}%</div>
        </div>
      </div>
    </div>

    <div class="stat-strip">
      <div class="stat-strip-item">
        <div class="stat-strip-label">Win rate</div>
        <div class="stat-strip-value">${allStats.winRate.toFixed(0)}%</div>
      </div>
      <div class="stat-strip-item">
        <div class="stat-strip-label">Active trades</div>
        <div class="stat-strip-value">${ongoingTrades.length}</div>
      </div>
    </div>

    ${streakCardHtml()}

    <div class="weekly-recap-card">
      <div class="weekly-recap-head">
        <div class="weekly-recap-head-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          Weekly recap (last 7 days)
        </div>
        <span class="weekly-recap-badge">${recap.trades.length} trade${recap.trades.length !== 1 ? "s" : ""}</span>
      </div>
      <div class="weekly-recap-grid">
        <div class="weekly-recap-item">
          <div class="weekly-recap-label">Net P&amp;L</div>
          <div class="weekly-recap-value" style="color:${recap.stats.totalPnl < 0 ? "var(--sell)" : "var(--text)"}">${recap.stats.totalPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(recap.stats.totalPnl))}</div>
        </div>
        <div class="weekly-recap-item">
          <div class="weekly-recap-label">Win rate</div>
          <div class="weekly-recap-value">${recap.stats.winRate.toFixed(0)}%</div>
        </div>
        <div class="weekly-recap-item">
          <div class="weekly-recap-label">Top pair</div>
          <div class="weekly-recap-value">${escapeHtml(recap.topPair)}</div>
        </div>
      </div>
    </div>

    <div class="section-label-row">
      <div class="section-label">Ongoing trades (${ongoingTrades.length})</div>
      ${layoutToggleBtnHtml("homeLayoutToggleBtn")}
    </div>
    <div class="ongoing-list ${ongoingLayoutCompact ? "compact" : ""}">`;
  html +=
    ongoingTrades.length === 0
      ? emptyStateHtml({
          icon: `<div class="empty-state-icon-square">${ICON_X_SQUARE}</div>`,
          title: "No active open positions",
          sub: "Open a new planned trade with risk math, or directly log a past closed trade.",
          ctaLabel: "Open trade",
          ctaId: "emptyAddBtn",
        })
      : ongoingTrades.map(ongoingCardSwipeHtml).join("");
  html += `</div>`;
  return html;
}

function moodChipsHtml(moodTags) {
  if (!moodTags || !moodTags.length) return "";
  return `<div class="mood-chip-row">${moodTags.map((m) => `<span class="mood-chip">${escapeHtml(m)}</span>`).join("")}</div>`;
}

function closedRowHtml(t) {
  const color = t.pnl < 0 ? "var(--sell)" : "var(--win)";
  return `<div class="closed-row">
      <div>
        <div style="display:flex;align-items:center;margin-bottom:4px;"><span class="pair-name" style="font-size:13px;">${escapeHtml(t.pair)}</span>${directionTag(t.direction)}</div>
        <div class="closed-meta">${fmtPrice(t.entry)} → ${fmtPrice(t.exit)} · ${new Date(t.closedAt).toLocaleDateString()}</div>
        ${moodChipsHtml(t.moodTags)}
      </div>
      <div class="closed-pnl"><div style="color:${color}">${fmtMoney(t.pnl)}</div><div class="closed-result" style="color:${color}">${t.result}</div></div>
    </div>`;
}

const CLOSED_EDITED_KEY = "tb_closedEditedIds";
function getClosedEditedIds() {
  try {
    return JSON.parse(localStorage.getItem(CLOSED_EDITED_KEY) || "[]");
  } catch {
    return [];
  }
}
function markClosedTradeEdited(id) {
  const ids = getClosedEditedIds();
  if (!ids.includes(id)) {
    ids.push(id);
    localStorage.setItem(CLOSED_EDITED_KEY, JSON.stringify(ids));
  }
}
function closedTradeAlreadyEdited(id) {
  return getClosedEditedIds().includes(id);
}

function closedRowSwipeHtml(t) {
  if (closedTradeAlreadyEdited(t.id)) return closedRowHtml(t);
  const open = openClosedDropdownId === t.id;
  return `<div class="closed-row-wrap">
      <button type="button" class="closed-row-tap-btn ${open ? "open" : ""}" data-id="${t.id}" aria-label="Options for ${escapeHtml(t.pair)} closed trade">
        ${closedRowHtml(t)}
        <span class="closed-row-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span>
      </button>
      ${
        open
          ? `<div class="closed-row-dropdown">
               <button type="button" class="closed-row-dropdown-item edit-closed-trade-btn" data-id="${t.id}">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                 Edit closing price
               </button>
             </div>`
          : ""
      }
    </div>`;
}

function renderTrades() {
  let html = `<div class="subtabs">
      <button class="subtab-btn ${currentSubTab === "ongoing" ? "active" : ""}" data-sub="ongoing">Ongoing (${ongoingTrades.length})</button>
      <button class="subtab-btn ${currentSubTab === "closed" ? "active" : ""}" data-sub="closed">Closed (${closedTrades.length})</button>
    </div>`;
  if (currentSubTab === "ongoing") {
    html += `<div class="section-label-row">
        <div class="section-label">Ongoing</div>
        ${layoutToggleBtnHtml("tradesLayoutToggleBtn")}
      </div>
      <div class="ongoing-list ${ongoingLayoutCompact ? "compact" : ""}">`;
    html +=
      ongoingTrades.length === 0
        ? emptyStateHtml({
            icon: ICON_CANDLES,
            title: "No open trades",
            sub: "Whatever you take next shows up here until you close it.",
            ctaLabel: "Add a trade",
            ctaId: "emptyAddBtn2",
          })
        : ongoingTrades.map(ongoingCardSwipeHtml).join("");
    html += `</div>`;
  } else {
    html +=
      closedTrades.length === 0
        ? emptyStateHtml({
            icon: ICON_CHART,
            title: "Nothing closed yet",
            sub: "Close out an open trade and it'll land here with its full result.",
          })
        : closedTrades.map(closedRowSwipeHtml).join("");
  }
  return html;
}

// ============================================================
// PERFORMANCE TAB
// ============================================================
function rangeCutoff(range) {
  const now = new Date();
  const d = new Date(now);
  if (range === "1D") d.setDate(d.getDate() - 1);
  else if (range === "1W") d.setDate(d.getDate() - 7);
  else if (range === "1M") d.setMonth(d.getMonth() - 1);
  else if (range === "3M") d.setMonth(d.getMonth() - 3);
  else return null;
  return d;
}

function tradesInRange(range) {
  const cutoff = rangeCutoff(range);
  if (!cutoff) return [...closedTrades];
  return closedTrades.filter((t) => new Date(t.closedAt) >= cutoff);
}

function computeStats(trades) {
  const total = trades.length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const winRate = total ? (wins.length / total) * 100 : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectancy = total ? totalPnl / total : 0;
  return {
    total,
    totalPnl,
    winRate,
    wins: wins.length,
    losses: losses.length,
    profitFactor,
    expectancy,
  };
}

const MOOD_TAG_MIN_SAMPLE = 2;

function moodStatsForTrades(trades) {
  const byTag = {};
  trades.forEach((t) => {
    (t.moodTags || []).forEach((tag) => {
      if (!byTag[tag]) byTag[tag] = { tag, count: 0, wins: 0, pnl: 0 };
      byTag[tag].count += 1;
      if (t.pnl > 0) byTag[tag].wins += 1;
      byTag[tag].pnl += t.pnl;
    });
  });
  return Object.values(byTag)
    .map((m) => ({ ...m, winRate: m.count ? (m.wins / m.count) * 100 : 0 }))
    .sort((a, b) => a.winRate - b.winRate);
}

function moodInsightCardHtml(trades) {
  const moodStats = moodStatsForTrades(trades).filter(
    (m) => m.count >= MOOD_TAG_MIN_SAMPLE,
  );
  if (!moodStats.length) return "";
  const worst = moodStats[0];
  return `
    <div class="mood-insight-card">
      <div class="section-label" style="margin-top:0;">Mood patterns</div>
      <div class="mood-insight-highlight">
        <div class="mood-insight-highlight-label">Lowest win rate when tagged</div>
        <div class="mood-insight-highlight-value">
          <span class="mood-chip">${escapeHtml(worst.tag)}</span>
          <span style="color:${worst.winRate < 50 ? "var(--sell)" : "var(--win)"}">${worst.winRate.toFixed(0)}% win rate</span>
          <span class="hint" style="display:inline;margin:0;">(${worst.count} trades)</span>
        </div>
      </div>
      <div class="mood-insight-list">
        ${moodStats
          .map(
            (m) => `
          <div class="mood-insight-row">
            <span class="mood-chip">${escapeHtml(m.tag)}</span>
            <span class="mood-insight-bar-wrap"><span class="mood-insight-bar" style="width:${m.winRate.toFixed(0)}%;background:${m.winRate < 50 ? "var(--sell)" : "var(--win)"}"></span></span>
            <span class="mood-insight-pct">${m.winRate.toFixed(0)}%</span>
          </div>`,
          )
          .join("")}
      </div>
    </div>`;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function calendarDayMap(monthDate) {
  const map = {};
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  closedTrades.forEach((t) => {
    const d = new Date(t.closedAt);
    if (d.getFullYear() === y && d.getMonth() === m) {
      const key = dateKey(d);
      if (!map[key]) map[key] = { pnl: 0, count: 0, trades: [] };
      map[key].pnl += t.pnl;
      map[key].count += 1;
      map[key].trades.push(t);
    }
  });
  return map;
}

function renderPerfCalendar() {
  const monthDate = perfCalendarMonth;
  const dayMap = calendarDayMap(monthDate);
  const y = monthDate.getFullYear();
  const m = monthDate.getMonth();
  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const monthLabel = monthDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const maxAbsPnl = Math.max(
    1,
    ...Object.values(dayMap).map((d) => Math.abs(d.pnl)),
  );

  let cells = "";
  for (let i = 0; i < startWeekday; i++) {
    cells += `<div class="calendar-day empty"></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(new Date(y, m, day));
    const info = dayMap[key];
    let style = "";
    let cls = "calendar-day";
    if (info) {
      const intensity = Math.min(1, Math.abs(info.pnl) / maxAbsPnl);
      const alpha = Math.round((0.15 + intensity * 0.65) * 100);
      const base = info.pnl < 0 ? "var(--sell)" : "var(--win)";
      style = `style="background:color-mix(in srgb, ${base} ${alpha}%, transparent);"`;
      cls += info.pnl < 0 ? " has-loss" : " has-win";
    }
    if (key === selectedCalendarDateKey) cls += " selected";
    cells += `<button type="button" class="${cls}" data-date="${key}" ${style}><span class="calendar-day-num">${day}</span></button>`;
  }

  const selectedInfo = selectedCalendarDateKey
    ? dayMap[selectedCalendarDateKey]
    : null;
  let selectedLabel = "";
  if (selectedCalendarDateKey) {
    const [sy, sm, sd] = selectedCalendarDateKey.split("-").map(Number);
    selectedLabel = new Date(sy, sm - 1, sd).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }

  return `
    <div class="calendar-card">
      <div class="calendar-head">
        <button type="button" class="calendar-nav-btn" data-cal-dir="-1" aria-label="Previous month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="calendar-month-label">${monthLabel}</div>
        <button type="button" class="calendar-nav-btn" data-cal-dir="1" aria-label="Next month">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
      <div class="calendar-weekday-row">
        ${["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="calendar-weekday-label">${d}</div>`).join("")}
      </div>
      <div class="calendar-grid">${cells}</div>
      ${
        selectedInfo
          ? `<div class="calendar-day-detail">
              <div class="calendar-day-detail-head">
                <span>${selectedLabel}</span>
                <span style="color:${selectedInfo.pnl < 0 ? "var(--sell)" : "var(--win)"}">${selectedInfo.pnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(selectedInfo.pnl))}</span>
              </div>
              ${selectedInfo.trades.map(closedRowHtml).join("")}
            </div>`
          : selectedCalendarDateKey
            ? `<div class="calendar-day-detail"><div class="hint" style="margin:0;">No closed trades that day.</div></div>`
            : ""
      }
    </div>`;
}

function renderPerformance() {
  const groups = {};
  const sorted = [...closedTrades].sort(
    (a, b) => new Date(a.closedAt) - new Date(b.closedAt),
  );
  for (const t of sorted) {
    const key = periodKey(t.closedAt, perfGranularity);
    if (!groups[key])
      groups[key] = {
        key,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        pnl: 0,
        count: 0,
      };
    groups[key].balanceAfter = t.balanceAfter;
    groups[key].pnl += t.pnl;
    groups[key].count += 1;
  }
  const rows = Object.values(groups).reverse();

  const rangeTrades = tradesInRange(perfRange);
  const stats = computeStats(rangeTrades);
  const pfLabel =
    stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2);

  let html = `
    <div class="perf-chart-card">
      <div class="perf-chart-head">
        <div>
          <div class="perf-chart-eyebrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8M21 7v6h-6"/></svg>
            Performance
          </div>
          <div class="perf-chart-total display" style="color:${stats.totalPnl < 0 ? "var(--sell)" : "var(--text)"}">${stats.totalPnl >= 0 ? "+" : ""}${fmtMoney(stats.totalPnl).replace("-", "")}</div>
        </div>
        <div class="range-picker">
          ${["1D", "1W", "1M", "3M", "ALL"]
            .map(
              (r) =>
                `<button type="button" class="range-btn ${perfRange === r ? "active" : ""}" data-range="${r}">${r}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="perf-chart-svg-wrap" id="perfChartWrap"></div>
    </div>

    <div class="stat-row">
      ${renderStatCard("Total P&L", `${stats.totalPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(stats.totalPnl)).replace("$", "$")}`)}
      ${renderStatCard("Win rate", `${stats.winRate.toFixed(1)}%`)}
      ${renderStatCard("Profit factor", pfLabel)}
      ${renderStatCard("Expectancy", fmtMoney(stats.expectancy))}
    </div>
    <div class="hint" style="margin:-10px 0 18px;">${stats.wins} wins · ${stats.losses} losses · from ${stats.total} closed trade${stats.total !== 1 ? "s" : ""}</div>

    <div class="section-label" style="margin-top:0;">Calendar</div>
    ${renderPerfCalendar()}

    ${moodInsightCardHtml(rangeTrades)}

    <div class="section-label">Breakdown</div>
    <div class="subtabs">
      ${["day", "month", "year"].map((g) => `<button class="subtab-btn perf-gran-btn ${perfGranularity === g ? "active" : ""}" data-gran="${g}">By ${g}</button>`).join("")}
    </div>`;

  if (rows.length === 0) {
    html += emptyStateHtml({
      icon: ICON_CHART,
      title: "No performance data yet",
      sub: "Win rate, profit factor, and expectancy all need at least one closed trade to calculate.",
      ctaLabel:
        ongoingTrades.length > 0 ? "View open trades" : "Add your first trade",
      ctaId: "emptyPerfBtn",
    });
  } else {
    html += rows
      .map((r) => {
        const pct =
          ((r.balanceAfter - r.balanceBefore) / r.balanceBefore) * 100;
        return `<div class="perf-row">
          <div><div style="font-size:13px;font-weight:600;">${periodLabel(r.key, perfGranularity)}</div><div class="closed-meta">${r.count} trade${r.count !== 1 ? "s" : ""} · ${fmtMoney(r.pnl)}</div></div>
          <div class="display" style="font-size:18px;color:${pct < 0 ? "var(--sell)" : "var(--text)"}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</div>
        </div>`;
      })
      .join("");
  }
  return html;
}

function drawPerfChart() {
  const wrap = document.getElementById("perfChartWrap");
  if (!wrap) return;
  const trades = tradesInRange(perfRange).sort(
    (a, b) => new Date(a.closedAt) - new Date(b.closedAt),
  );

  const w = Math.max(wrap.clientWidth || 320, 260);
  const h = 200;
  const padL = 6,
    padR = 6,
    padT = 14,
    padB = 22;

  if (trades.length === 0) {
    wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
        ${gridLinesSvg(w, h, padL, padR, padT, padB)}
      </svg><div class="perf-chart-empty">No trades taken</div>`;
    return;
  }

  let cum = 0;
  const points = [{ label: "start", cum: 0, date: null }];
  trades.forEach((t) => {
    cum += t.pnl;
    points.push({ label: t.pair, cum, date: t.closedAt });
  });

  const values = points.map((p) => p.cum);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const range = max - min;

  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = padL + i * xStep;
    const y = padT + plotH - ((p.cum - min) / range) * plotH;
    return { x, y, p };
  });

  const linePath = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const zeroY = padT + plotH - ((0 - min) / range) * plotH;
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;

  const isUp = cum >= 0;
  const lineColor = isUp ? "var(--text)" : "var(--sell)";

  const firstLabel = points[1] ? fmtChartDate(points[1].date) : "";
  const lastLabel = points[points.length - 1].date
    ? fmtChartDate(points[points.length - 1].date)
    : "";

  wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
      ${gridLinesSvg(w, h, padL, padR, padT, padB)}
      <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${w - padR}" y2="${zeroY.toFixed(1)}" stroke="var(--border-light)" stroke-width="1" stroke-dasharray="3,3" />
      <path d="${areaPath}" fill="${lineColor}" opacity="0.08" stroke="none" />
      <path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${coords[coords.length - 1].x.toFixed(1)}" cy="${coords[coords.length - 1].y.toFixed(1)}" r="3.5" fill="${lineColor}" />
      <text x="${padL}" y="${h - 6}" font-size="10" fill="var(--text-faint)" font-family="Inter, sans-serif">${escapeHtml(firstLabel)}</text>
      <text x="${w - padR}" y="${h - 6}" font-size="10" fill="var(--text-faint)" font-family="Inter, sans-serif" text-anchor="end">${escapeHtml(lastLabel)}</text>
    </svg>`;
}

function gridLinesSvg(w, h, padL, padR, padT, padB) {
  const rows = 4;
  let lines = "";
  for (let i = 0; i <= rows; i++) {
    const y = padT + (i * (h - padT - padB)) / rows;
    lines += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`;
  }
  return lines;
}

function fmtChartDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

window.addEventListener("resize", () => {
  if (currentTab === "performance") drawPerfChart();
});

// ============================================================
// SETTINGS TAB
// ============================================================
function initialsFromName(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")
  ).toUpperCase();
}
function resolveAvatarUrl() {
  if (!currentUser) return null;
  const meta = currentUser.user_metadata || {};
  if (meta.custom_avatar_url) return meta.custom_avatar_url;
  if (meta.avatar_url) return meta.avatar_url;
  if (meta.picture) return meta.picture;
  const identities = currentUser.identities || [];
  const google = identities.find((i) => i.provider === "google");
  const idData = (google && google.identity_data) || {};
  return idData.avatar_url || idData.picture || null;
}
function avatarHtml() {
  const url = resolveAvatarUrl();
  if (url) {
    return `<img class="avatar" src="${escapeHtml(url)}" alt="Profile picture" />`;
  }
  return `<div class="avatar">${escapeHtml(initialsFromName(profile.name))}</div>`;
}

function renderSettings() {
  const theme = localStorage.getItem(THEME_KEY) || "light";
  const accountType = getAccountType();
  const isGoogleUser = (currentUser?.app_metadata?.providers || []).includes(
    "google",
  );
  return `
      <div class="settings-block">
        <div class="settings-block-head">
          <h3>Account</h3>
          <button class="btn-icon-small" id="editAccountBtn">${accountEditOpen ? "Cancel" : "Edit"}</button>
        </div>
        <div class="account-top">
          <button
            type="button"
            id="editAvatarTrigger"
            class="account-avatar-btn"
            ${accountEditOpen ? "" : 'disabled tabindex="-1"'}
            aria-label="Change profile picture"
          >
            ${pendingAvatarPreviewUrl ? `<img class="avatar" src="${pendingAvatarPreviewUrl}" alt="Profile picture" />` : avatarHtml()}
            ${accountEditOpen ? `<span class="account-avatar-edit-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span>` : ""}
          </button>
          <div>
            <div class="account-line"><span>Name:</span> ${escapeHtml(profile.name)}</div>
            <div class="account-line"><span>Email:</span> ${escapeHtml(profile.email)}</div>
            ${
              !accountEditOpen
                ? ""
                : `<div class="hint">Tap your picture to change it${isGoogleUser ? " — this replaces the one synced from Google" : ""}.</div>`
            }
          </div>
        </div>
        ${
          accountEditOpen
            ? `<form id="editAccountForm">
                <div class="field">
                  <label class="field-label">Display name</label>
                  <input class="field-input" id="editNameInput" value="${escapeHtml(profile.name)}" required />
                </div>
                <div class="auth-error" id="editNameError"></div>
                <button type="submit" class="btn-primary" id="editAccountSubmitBtn">Save changes</button>
              </form>`
            : `<button class="btn-outline" id="logoutBtn" style="width:100%;">Log out</button>`
        }
      </div>

      <div class="settings-block">
        <h3>Appearance</h3>
        <p>Switch between light and dark mode. Applies immediately.</p>
        <div class="theme-picker">
          <button class="theme-btn ${theme === "light" ? "active" : ""}" data-theme-choice="light">Light</button>
          <button class="theme-btn ${theme === "dark" ? "active" : ""}" data-theme-choice="dark">Dark</button>
        </div>
      </div>

      <div class="settings-block">
        <h3>Trading account type</h3>
        <p>Used to double-check your risk against your lot size on gold and forex trades. Set this once to match how your broker (e.g. Exness, XM) set up your account — most traders use Standard.</p>
        <div class="theme-picker">
          <button class="theme-btn ${accountType === "standard" ? "active" : ""}" data-accounttype-choice="standard">Standard</button>
          <button class="theme-btn ${accountType === "cent" ? "active" : ""}" data-accounttype-choice="cent">Cent / Micro</button>
        </div>
      </div>

      <div class="settings-block">
        <h3>Balance</h3>
        <p>Manually correct your current balance — for a deposit, withdrawal, or fixing a mistake. This is tracked separately from your trading results, so it won't skew your win rate or all-time performance %.</p>
        <form id="editBalanceForm">
          <div class="settings-row">
            <div class="field balance-prefix-wrap">
              <span class="balance-prefix">$</span>
              <input class="field-input" id="editBalanceInput" type="number" step="any" value="${Number(profile.balance).toFixed(2)}" required />
            </div>
            <button type="submit" class="btn-outline" style="width:auto;padding:0 18px;">Update</button>
          </div>
        </form>
        <div class="hint">Starting balance was ${fmtMoney(profile.initial_balance)}. Trading performance is always measured from your actual trade results, not balance edits.</div>
      </div>

      <div class="settings-block">
        <h3>Help</h3>
        <p>Get a quick refresher on the home screen — adding trades, reading your stats, and where everything lives.</p>
        <button class="btn-outline" id="restartTourBtn" style="width:100%;">Take the welcome tour</button>
      </div>

      <div class="settings-block">
        <h3>Backup</h3>
        <p>Your data lives in your Tradebook account now, not just this browser — logging in anywhere gives you the same trades. This just exports a local copy.</p>
        <button class="btn-outline" id="exportDataBtn" style="width:100%;">Export data</button>
      </div>

      <div class="settings-block">
        <h3>Danger zone</h3>
        <p>Permanently delete every trade you've logged and start fresh with a new starting balance. This can't be undone.</p>
        <form id="clearAllDataForm">
          <div class="field balance-prefix-wrap">
            <span class="balance-prefix">$</span>
            <input class="field-input" id="newStartingBalanceInput" type="number" step="any" placeholder="${Number(profile.initial_balance).toFixed(2)}" />
          </div>
          <div class="hint" style="margin-bottom:10px;">Leave blank to reuse your current starting balance of ${fmtMoney(profile.initial_balance)}.</div>
          <button type="submit" class="btn-danger" id="clearAllDataBtn">Clear all data & restart</button>
        </form>
      </div>
    `;
}

// ============================================================
// listeners
// ============================================================
function attachContentListeners() {
  const addBtn = document.getElementById("openAddBtn");
  if (addBtn) addBtn.addEventListener("click", openAddModal);
  const addClosedBtn = document.getElementById("openAddClosedBtn");
  if (addClosedBtn) addClosedBtn.addEventListener("click", openAddClosedModal);
  ["emptyAddBtn", "emptyAddBtn2"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", openAddModal);
  });
  const emptyPerfBtn = document.getElementById("emptyPerfBtn");
  if (emptyPerfBtn) {
    emptyPerfBtn.addEventListener("click", () => {
      if (ongoingTrades.length > 0) {
        currentTab = "trades";
        currentSubTab = "ongoing";
        document
          .querySelectorAll(".nav-btn")
          .forEach((b) =>
            b.classList.toggle("active", b.dataset.tab === "trades"),
          );
        renderMain();
      } else {
        openAddModal();
      }
    });
  }
  document
    .querySelectorAll(".close-trade-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () => openCloseModal(btn.dataset.id)),
    );
  document
    .querySelectorAll(".edit-trade-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () => openEditModal(btn.dataset.id)),
    );
  document
    .querySelectorAll(".delete-trade-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () => deleteOngoingTrade(btn.dataset.id)),
    );
  document.querySelectorAll(".edit-closed-trade-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      openClosedDropdownId = null;
      openEditClosedModal(btn.dataset.id);
    }),
  );
  document.querySelectorAll(".closed-row-tap-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      openClosedDropdownId = openClosedDropdownId === id ? null : id;
      renderMain();
    }),
  );
  document.querySelectorAll(".subtab-btn[data-sub]").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentSubTab = btn.dataset.sub;
      renderMain();
    }),
  );
  document.querySelectorAll(".perf-gran-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      perfGranularity = btn.dataset.gran;
      renderMain();
    }),
  );
  document.querySelectorAll(".range-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      perfRange = btn.dataset.range;
      renderMain();
    }),
  );
  document.querySelectorAll(".calendar-nav-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const dir = parseInt(btn.dataset.calDir, 10);
      const d = new Date(perfCalendarMonth);
      d.setMonth(d.getMonth() + dir);
      perfCalendarMonth = d;
      selectedCalendarDateKey = null;
      renderMain();
    }),
  );
  document.querySelectorAll(".calendar-day[data-date]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.date;
      selectedCalendarDateKey = selectedCalendarDateKey === key ? null : key;
      renderMain();
    }),
  );
  document.querySelectorAll(".theme-btn[data-theme-choice]").forEach((btn) =>
    btn.addEventListener("click", () => {
      setTheme(btn.dataset.themeChoice);
      renderMain();
    }),
  );
  document
    .querySelectorAll(".theme-btn[data-accounttype-choice]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        setAccountType(btn.dataset.accounttypeChoice);
        renderMain();
      }),
    );

  document
    .querySelectorAll(".layout-toggle-btn")
    .forEach((btn) => btn.addEventListener("click", toggleOngoingLayout));

  attachSwipeHandlers();

  const editAccountBtn = document.getElementById("editAccountBtn");
  if (editAccountBtn)
    editAccountBtn.addEventListener("click", () => {
      accountEditOpen = !accountEditOpen;
      pendingAvatarFile = null;
      if (pendingAvatarPreviewUrl) {
        URL.revokeObjectURL(pendingAvatarPreviewUrl);
        pendingAvatarPreviewUrl = null;
      }
      renderMain();
    });

  const editAvatarTrigger = document.getElementById("editAvatarTrigger");
  if (editAvatarTrigger)
    editAvatarTrigger.addEventListener("click", () => {
      if (!accountEditOpen) return;
      document.getElementById("avatarFileInput").click();
    });

  const editAccountForm = document.getElementById("editAccountForm");
  if (editAccountForm) {
    editAccountForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newName = document.getElementById("editNameInput").value.trim();
      const errEl = document.getElementById("editNameError");
      const btn = document.getElementById("editAccountSubmitBtn");
      if (!newName) return;
      setBusy(btn, true);

      if (pendingAvatarFile) {
        try {
          const ext = pendingAvatarFile.name.split(".").pop();
          const path = `${currentUser.id}-${Date.now()}.${ext}`;
          const { error: upErr } = await sb.storage
            .from("avatars")
            .upload(path, pendingAvatarFile, { upsert: true });
          if (upErr) throw upErr;
          const { data: pub } = sb.storage.from("avatars").getPublicUrl(path);
          const { data: updatedUser, error: authErr } =
            await sb.auth.updateUser({
              data: { custom_avatar_url: pub.publicUrl },
            });
          if (authErr) throw authErr;
          currentUser = updatedUser.user;
        } catch (err) {
          setBusy(btn, false, "Save changes");
          errEl.textContent =
            "Could not upload picture. Make sure a public 'avatars' storage bucket exists in Supabase. " +
            (err.message || "");
          return;
        }
      }

      const { data, error } = await sb
        .from("profiles")
        .update({ name: newName })
        .eq("id", currentUser.id)
        .select()
        .single();
      setBusy(btn, false, "Save changes");
      if (error) {
        errEl.textContent = "Could not save changes. " + error.message;
        return;
      }
      profile = data;
      accountEditOpen = false;
      pendingAvatarFile = null;
      if (pendingAvatarPreviewUrl) {
        URL.revokeObjectURL(pendingAvatarPreviewUrl);
        pendingAvatarPreviewUrl = null;
      }
      renderMain();
      showToast("Account updated");
    });
  }

  const editBalanceForm = document.getElementById("editBalanceForm");
  if (editBalanceForm) {
    editBalanceForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = parseFloat(document.getElementById("editBalanceInput").value);
      if (Number.isNaN(val) || val < 0) return;

      const delta = val - profile.balance;
      const newInitial = profile.initial_balance + delta;

      const { data, error } = await sb
        .from("profiles")
        .update({ balance: val, initial_balance: newInitial })
        .eq("id", currentUser.id)
        .select()
        .single();
      if (error) {
        showSaveError("Could not update balance. " + error.message);
        return;
      }
      profile = data;
      renderMain();
      showToast("Balance updated");
    });
  }

  const exportBtn = document.getElementById("exportDataBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportData);

  const restartTourBtn = document.getElementById("restartTourBtn");
  if (restartTourBtn)
    restartTourBtn.addEventListener("click", () => startTour());

  const clearAllDataForm = document.getElementById("clearAllDataForm");
  if (clearAllDataForm)
    clearAllDataForm.addEventListener("submit", clearAllData);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn)
    logoutBtn.addEventListener("click", async () => {
      await sb.auth.signOut();
      currentUser = null;
      profile = null;
      window.location.href = AUTH_URL;
    });
}

// ---------- profile picture crop ----------
const CROP_CANVAS_SIZE = 320;
const CROP_OUTPUT_SIZE = 480;
let cropImg = null;
let cropSourceFileName = "avatar.jpg";
let cropBaseScale = 1;
let cropScale = 1;
let cropOffsetX = 0;
let cropOffsetY = 0;
let cropDragging = false;
let cropDragStartX = 0;
let cropDragStartY = 0;
let cropOffsetStartX = 0;
let cropOffsetStartY = 0;

function cropClampOffsets() {
  const scale = cropBaseScale * cropScale;
  const w = cropImg.width * scale;
  const h = cropImg.height * scale;
  const maxOffsetX = Math.max(0, (w - CROP_CANVAS_SIZE) / 2);
  const maxOffsetY = Math.max(0, (h - CROP_CANVAS_SIZE) / 2);
  cropOffsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, cropOffsetX));
  cropOffsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, cropOffsetY));
}

function drawCrop() {
  const canvas = document.getElementById("cropCanvas");
  canvas.width = CROP_CANVAS_SIZE;
  canvas.height = CROP_CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, CROP_CANVAS_SIZE, CROP_CANVAS_SIZE);
  const scale = cropBaseScale * cropScale;
  const w = cropImg.width * scale;
  const h = cropImg.height * scale;
  const x = CROP_CANVAS_SIZE / 2 - w / 2 + cropOffsetX;
  const y = CROP_CANVAS_SIZE / 2 - h / 2 + cropOffsetY;
  ctx.drawImage(cropImg, x, y, w, h);
}

function openCropModal(file) {
  cropSourceFileName = file.name || "avatar.jpg";
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    cropImg = img;
    cropBaseScale = Math.max(
      CROP_CANVAS_SIZE / img.width,
      CROP_CANVAS_SIZE / img.height,
    );
    cropScale = 1;
    cropOffsetX = 0;
    cropOffsetY = 0;
    document.getElementById("cropZoomSlider").value = "1";
    drawCrop();
    document.getElementById("cropModal").classList.remove("hidden");
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

document.getElementById("avatarFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  openCropModal(file);
});

const cropStage = document.getElementById("cropStage");
cropStage.addEventListener("pointerdown", (e) => {
  if (!cropImg) return;
  cropDragging = true;
  cropDragStartX = e.clientX;
  cropDragStartY = e.clientY;
  cropOffsetStartX = cropOffsetX;
  cropOffsetStartY = cropOffsetY;
  cropStage.setPointerCapture(e.pointerId);
});
cropStage.addEventListener("pointermove", (e) => {
  if (!cropDragging || !cropImg) return;
  const rect = cropStage.getBoundingClientRect();
  const factor = CROP_CANVAS_SIZE / rect.width;
  cropOffsetX = cropOffsetStartX + (e.clientX - cropDragStartX) * factor;
  cropOffsetY = cropOffsetStartY + (e.clientY - cropDragStartY) * factor;
  cropClampOffsets();
  drawCrop();
});
["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
  cropStage.addEventListener(evt, () => {
    cropDragging = false;
  }),
);

document.getElementById("cropZoomSlider").addEventListener("input", (e) => {
  if (!cropImg) return;
  cropScale = parseFloat(e.target.value);
  cropClampOffsets();
  drawCrop();
});

function closeCropModal() {
  document.getElementById("cropModal").classList.add("hidden");
  cropImg = null;
  cropDragging = false;
}
document
  .getElementById("cropModalClose")
  .addEventListener("click", closeCropModal);

document.getElementById("cropConfirmBtn").addEventListener("click", () => {
  if (!cropImg) return;
  const scale = cropBaseScale * cropScale;
  const w = cropImg.width * scale;
  const h = cropImg.height * scale;
  const x = CROP_CANVAS_SIZE / 2 - w / 2 + cropOffsetX;
  const y = CROP_CANVAS_SIZE / 2 - h / 2 + cropOffsetY;
  const srcX = -x / scale;
  const srcY = -y / scale;
  const srcW = CROP_CANVAS_SIZE / scale;
  const srcH = CROP_CANVAS_SIZE / scale;

  const out = document.createElement("canvas");
  out.width = CROP_OUTPUT_SIZE;
  out.height = CROP_OUTPUT_SIZE;
  const octx = out.getContext("2d");
  octx.drawImage(
    cropImg,
    srcX,
    srcY,
    srcW,
    srcH,
    0,
    0,
    CROP_OUTPUT_SIZE,
    CROP_OUTPUT_SIZE,
  );

  out.toBlob(
    (blob) => {
      if (!blob) return;
      const ext = /\.\w+$/.exec(cropSourceFileName)?.[0] || ".jpg";
      pendingAvatarFile = new File([blob], `avatar${ext}`, {
        type: "image/jpeg",
      });
      if (pendingAvatarPreviewUrl) URL.revokeObjectURL(pendingAvatarPreviewUrl);
      pendingAvatarPreviewUrl = URL.createObjectURL(blob);
      closeCropModal();
      renderMain();
    },
    "image/jpeg",
    0.92,
  );
});

function showSaveError(msg) {
  document.getElementById("saveErrorBox").innerHTML =
    `<div class="save-error">${escapeHtml(msg)}</div>`;
  showToast(msg, "error");
}

// ---------- generic action feedback ----------
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>`;
const WARN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>`;
function showToast(msg, type = "success", duration = 3200) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : ""}`;
  el.innerHTML = `${type === "error" ? WARN_ICON : CHECK_ICON}<span>${escapeHtml(msg)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ---------- restart with a new starting balance ----------
async function clearAllData(e) {
  e.preventDefault();
  const raw = document.getElementById("newStartingBalanceInput").value.trim();
  const newStart = raw ? parseFloat(raw) : profile.initial_balance;
  if (Number.isNaN(newStart) || newStart <= 0) {
    showSaveError("Enter a valid starting balance above zero.");
    return;
  }
  const sure = confirm(
    "Delete all trades and restart with a starting balance of " +
      fmtMoney(newStart) +
      "? This can't be undone.",
  );
  if (!sure) return;
  const btn = document.getElementById("clearAllDataBtn");
  setBusy(btn, true);

  const { error: delErr } = await sb
    .from("trades")
    .delete()
    .eq("user_id", currentUser.id);
  if (delErr) {
    setBusy(btn, false, "Clear all data & restart");
    showSaveError("Could not clear trades. " + delErr.message);
    return;
  }

  const { data: updatedProfile, error: profErr } = await sb
    .from("profiles")
    .update({ balance: newStart, initial_balance: newStart })
    .eq("id", currentUser.id)
    .select()
    .single();

  setBusy(btn, false, "Clear all data & restart");
  if (profErr) {
    showSaveError(
      "Trades cleared but balance reset failed. " + profErr.message,
    );
  }
  profile = updatedProfile || profile;
  ongoingTrades = [];
  closedTrades = [];
  renderMain();
  if (!profErr) showToast("All data cleared — fresh start");
}

function exportData() {
  const payload = {
    profile,
    ongoing: ongoingTrades,
    closed: closedTrades,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tradebook-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Data exported");
}

// ============================================================
// ADD TRADE MODAL
// ============================================================
function openAddModal() {
  document.getElementById("addTradeForm").reset();
  document.getElementById("addTradeError").textContent = "";
  formDirection = "Buy";
  document.getElementById("f_direction").value = "Buy";
  document.getElementById("f_pair").value = "";
  document.getElementById("f_pairDropdown").classList.add("hidden");
  addRiskMode = "percent";
  document
    .querySelectorAll(".risk-mode-btn")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.riskmode === "percent"),
    );
  document.getElementById("f_risk").placeholder = "15";
  document.getElementById("f_risk").readOnly = false;
  document.getElementById("f_riskField").classList.remove("locked");
  document
    .querySelectorAll("#addTradeForm .dir-btn[data-dir]")
    .forEach((b) => b.classList.toggle("active", b.dataset.dir === "Buy"));
  document.getElementById("addPreviewBox").classList.add("hidden");
  document.getElementById("f_riskAutoHint").classList.add("hidden");
  document.getElementById("checklistItems").classList.remove("open");
  document.getElementById("checklistToggle").classList.remove("open");
  document
    .querySelectorAll("#checklistItems input")
    .forEach((el) => (el.checked = false));
  document.getElementById("addModal").classList.remove("hidden");
}
function closeAddModal() {
  document.getElementById("addModal").classList.add("hidden");
}
document
  .getElementById("addModalClose")
  .addEventListener("click", closeAddModal);

function syncRiskFromLot() {
  const pair = document.getElementById("f_pair").value.trim();
  const entry = parseFloat(document.getElementById("f_entry").value);
  const slPrice = parseFloat(document.getElementById("f_sl").value);
  const lotSize = parseFloat(document.getElementById("f_lot").value);
  const riskInput = document.getElementById("f_risk");
  const hint = document.getElementById("f_riskAutoHint");
  const fieldWrap = document.getElementById("f_riskField");

  const lotEstimate = estimateRiskFromLot({ pair, entry, slPrice, lotSize });

  if (lotEstimate === null) {
    riskInput.readOnly = false;
    if (fieldWrap) fieldWrap.classList.remove("locked");

    const waitState = liveRateWaitState({ pair, entry, slPrice, lotSize });
    if (waitState === "loading") {
      hint.textContent = "Checking live rate…";
      hint.classList.remove("hidden");
    } else if (waitState === "failed") {
      hint.textContent = "Couldn't fetch a live rate — enter risk manually.";
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
    return;
  }

  riskInput.value =
    addRiskMode === "usd"
      ? lotEstimate.toFixed(2)
      : profile && profile.balance
        ? ((lotEstimate / profile.balance) * 100).toFixed(2)
        : lotEstimate.toFixed(2);
  riskInput.readOnly = true;
  if (fieldWrap) fieldWrap.classList.add("locked");

  if (profile && profile.balance) {
    const usdVal = lotEstimate;
    const pctVal = (lotEstimate / profile.balance) * 100;
    hint.innerHTML = `<b>Risking ${fmtMoney(usdVal)}</b> · ${pctVal.toFixed(2)}% — auto-calculated from lot size, entry &amp; stop.`;
  } else {
    hint.textContent = "Auto-calculated from lot size, entry & stop.";
  }
  hint.classList.remove("hidden");
}

document.querySelectorAll("#addTradeForm .dir-btn[data-dir]").forEach((btn) => {
  btn.addEventListener("click", () => {
    formDirection = btn.dataset.dir;
    document.getElementById("f_direction").value = formDirection;
    document
      .querySelectorAll("#addTradeForm .dir-btn[data-dir]")
      .forEach((b) => b.classList.toggle("active", b === btn));
    updateAddPreview();
  });
});

function readAddTradeForm() {
  const rawRisk = parseFloat(document.getElementById("f_risk").value);
  const riskPercent =
    addRiskMode === "usd" && profile && profile.balance
      ? (rawRisk / profile.balance) * 100
      : rawRisk;
  return {
    pair: document.getElementById("f_pair").value.trim().toUpperCase(),
    direction: document.getElementById("f_direction").value,
    entry: parseFloat(document.getElementById("f_entry").value),
    slPrice: parseFloat(document.getElementById("f_sl").value),
    tpPrice: parseFloat(document.getElementById("f_tp").value),
    lotSize: parseFloat(document.getElementById("f_lot").value),
    riskPercent,
  };
}

document.querySelectorAll(".risk-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const newMode = btn.dataset.riskmode;
    if (newMode === addRiskMode) return;
    const input = document.getElementById("f_risk");
    const raw = parseFloat(input.value);
    if (!Number.isNaN(raw) && profile && profile.balance) {
      if (addRiskMode === "percent" && newMode === "usd") {
        input.value = ((raw / 100) * profile.balance).toFixed(2);
      } else if (addRiskMode === "usd" && newMode === "percent") {
        input.value = ((raw / profile.balance) * 100).toFixed(2);
      }
    }
    addRiskMode = newMode;
    document
      .querySelectorAll(".risk-mode-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    input.placeholder = newMode === "usd" ? "150.00" : "15";
    syncRiskFromLot();
    updateAddPreview();
  });
});

function updateAddPreview() {
  const { entry, direction, slPrice, tpPrice, riskPercent } =
    readAddTradeForm();
  const box = document.getElementById("addPreviewBox");
  const errEl = document.getElementById("addTradeError");
  errEl.textContent = "";
  if (!entry || !slPrice || !tpPrice || !riskPercent) {
    box.classList.add("hidden");
    return;
  }
  if (slPrice === entry) {
    box.classList.add("hidden");
    errEl.textContent = "Stop loss can't equal entry price.";
    return;
  }

  const plan = computeTradePlan({
    entry,
    direction,
    slPrice,
    tpPrice,
    riskPercent,
    balance: profile.balance,
  });
  if (!plan) {
    box.classList.add("hidden");
    return;
  }
  const risk = riskLevelInfo(riskPercent);
  box.classList.remove("hidden");
  box.innerHTML = `
      <div class="preview-line"><span style="color:var(--text-faint)">Risking</span><span style="color:var(--sell)">${fmtMoney(plan.riskAmount)} of ${fmtMoney(profile.balance)}</span></div>
      <div class="preview-line"><span style="color:var(--text-faint)">Risk : reward</span><span>1 : ${plan.rr.toFixed(2)}</span></div>
      <div class="preview-line"><span style="color:var(--text-faint)">Potential reward</span><span>${fmtMoney(plan.potentialProfit)}</span></div>
      ${risk ? `<div class="preview-line" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);"><span style="color:${risk.color};font-weight:700;">${risk.label}</span></div>` : ""}
    `;
}

["f_pair", "f_entry", "f_sl", "f_tp", "f_lot", "f_risk"].forEach((id) => {
  const el = document.getElementById(id);
  const handler = () => {
    syncRiskFromLot();
    updateAddPreview();
  };
  el.addEventListener("input", handler);
  el.addEventListener("change", handler);
});

document
  .getElementById("addTradeForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("addTradeError");
    const btn = document.getElementById("addTradeSubmitBtn");
    const { pair, direction, entry, slPrice, tpPrice, lotSize, riskPercent } =
      readAddTradeForm();
    let notes = document.getElementById("f_notes").value.trim();
    if (!pair || !entry || !slPrice || !tpPrice || !lotSize || !riskPercent) {
      errEl.textContent = "Choose a pair and fill in all required fields.";
      return;
    }
    if (slPrice === entry) {
      errEl.textContent = "Stop loss can't equal entry price.";
      return;
    }
    if (
      riskPercent >= RISK_DANGER_PCT &&
      !confirm(
        `You're about to risk ${riskPercent.toFixed(1)}% of your balance (${fmtMoney((riskPercent / 100) * profile.balance)}) on this one trade. Open it anyway?`,
      )
    ) {
      return;
    }

    const plan = computeTradePlan({
      entry,
      direction,
      slPrice,
      tpPrice,
      riskPercent,
      balance: profile.balance,
    });
    if (!plan) return;

    const checked = readChecklist();
    if (checked.length) {
      const checklistSummary = `Pre-trade checklist: ${checked.join(", ")}`;
      notes = notes ? `${notes}\n\n${checklistSummary}` : checklistSummary;
    }

    setBusy(btn, true);
    const { data, error } = await sb
      .from("trades")
      .insert({
        user_id: currentUser.id,
        pair,
        direction,
        entry,
        lot_size: lotSize,
        risk_percent: riskPercent,
        rr: plan.rr,
        sl_price: slPrice,
        tp_price: tpPrice,
        risk_amount: plan.riskAmount,
        potential_profit: plan.potentialProfit,
        notes,
        status: "ongoing",
      })
      .select()
      .single();
    setBusy(btn, false, "Open trade");

    if (error) {
      errEl.textContent = friendlySaveError(error, "Could not save trade. ");
      return;
    }
    ongoingTrades.unshift(normalizeTrade(data));
    closeAddModal();
    renderMain();
    showToast(`${pair} trade opened`);
  });

// ============================================================
// EDIT TRADE MODAL
// ============================================================
function openEditModal(id) {
  editingTradeId = id;
  const trade = ongoingTrades.find((t) => t.id === id);
  if (!trade) return;

  document.getElementById("e_pair").value = trade.pair;
  document.getElementById("e_pairDropdown").classList.add("hidden");

  editFormDirection = trade.direction;
  document.getElementById("e_direction").value = trade.direction;
  document
    .querySelectorAll("#editTradeForm .dir-btn")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.editdir === trade.direction),
    );

  document.getElementById("e_entry").value = trade.entry;
  document.getElementById("e_sl").value = trade.slPrice;
  document.getElementById("e_tp").value = trade.tpPrice;
  document.getElementById("e_lot").value = trade.lotSize;
  document.getElementById("e_risk").value = trade.riskPercent;
  document.getElementById("e_notes").value = trade.notes || "";
  document.getElementById("editTradeError").textContent = "";
  document.getElementById("editPreviewBox").classList.add("hidden");
  document.getElementById("editModal").classList.remove("hidden");
  updateEditPreview();
}
function closeEditModal() {
  document.getElementById("editModal").classList.add("hidden");
  editingTradeId = null;
}
document
  .getElementById("editModalClose")
  .addEventListener("click", closeEditModal);

document.querySelectorAll("#editTradeForm .dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    editFormDirection = btn.dataset.editdir;
    document.getElementById("e_direction").value = editFormDirection;
    document
      .querySelectorAll("#editTradeForm .dir-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    updateEditPreview();
  });
});

function readEditTradeForm() {
  return {
    pair: document.getElementById("e_pair").value.trim().toUpperCase(),
    direction: document.getElementById("e_direction").value,
    entry: parseFloat(document.getElementById("e_entry").value),
    slPrice: parseFloat(document.getElementById("e_sl").value),
    tpPrice: parseFloat(document.getElementById("e_tp").value),
    lotSize: parseFloat(document.getElementById("e_lot").value),
    riskPercent: parseFloat(document.getElementById("e_risk").value),
  };
}

function updateEditPreview() {
  const { pair, entry, direction, slPrice, tpPrice, riskPercent, lotSize } =
    readEditTradeForm();
  const box = document.getElementById("editPreviewBox");
  const errEl = document.getElementById("editTradeError");
  errEl.textContent = "";
  if (!entry || !slPrice || !tpPrice || !riskPercent) {
    box.classList.add("hidden");
    return;
  }
  if (slPrice === entry) {
    box.classList.add("hidden");
    errEl.textContent = "Stop loss can't equal entry price.";
    return;
  }
  const plan = computeTradePlan({
    entry,
    direction,
    slPrice,
    tpPrice,
    riskPercent,
    balance: profile.balance,
  });
  if (!plan) {
    box.classList.add("hidden");
    return;
  }
  const risk = riskLevelInfo(riskPercent);
  const lotEstimate = estimateRiskFromLot({
    pair,
    entry,
    slPrice,
    lotSize,
  });
  const lotMismatch =
    lotEstimate !== null &&
    Math.abs(lotEstimate - plan.riskAmount) >
      Math.max(1, plan.riskAmount * 0.15);
  box.classList.remove("hidden");
  box.innerHTML = `
      <div class="preview-line"><span style="color:var(--text-faint)">Risking</span><span style="color:var(--sell)">${fmtMoney(plan.riskAmount)} of ${fmtMoney(profile.balance)}</span></div>
      <div class="preview-line"><span style="color:var(--text-faint)">Risk : reward</span><span>1 : ${plan.rr.toFixed(2)}</span></div>
      <div class="preview-line"><span style="color:var(--text-faint)">Potential reward</span><span>${fmtMoney(plan.potentialProfit)}</span></div>
      ${risk ? `<div class="preview-line" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);"><span style="color:${risk.color};font-weight:700;">${risk.label}</span></div>` : ""}
      ${
        lotMismatch
          ? `<div class="preview-line" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);"><span style="color:#d9a02a;font-size:11px;">Heads up — at ${lotSize} lots this stop actually risks about ${fmtMoney(lotEstimate)}, not ${fmtMoney(plan.riskAmount)}. Double-check your lot size or SL.</span></div>`
          : ""
      }
    `;
}

["e_entry", "e_sl", "e_tp", "e_lot", "e_risk"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateEditPreview);
  document.getElementById(id).addEventListener("change", updateEditPreview);
});

document
  .getElementById("editTradeForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("editTradeError");
    const btn = document.getElementById("editTradeSubmitBtn");
    if (!editingTradeId) return;
    const { pair, direction, entry, slPrice, tpPrice, lotSize, riskPercent } =
      readEditTradeForm();
    const notes = document.getElementById("e_notes").value.trim();
    if (!pair || !entry || !slPrice || !tpPrice || !lotSize || !riskPercent) {
      errEl.textContent = "Fill in all required fields.";
      return;
    }
    if (slPrice === entry) {
      errEl.textContent = "Stop loss can't equal entry price.";
      return;
    }
    if (
      riskPercent >= RISK_DANGER_PCT &&
      !confirm(
        `You're about to risk ${riskPercent.toFixed(1)}% of your balance (${fmtMoney((riskPercent / 100) * profile.balance)}) on this trade. Save anyway?`,
      )
    ) {
      return;
    }
    const plan = computeTradePlan({
      entry,
      direction,
      slPrice,
      tpPrice,
      riskPercent,
      balance: profile.balance,
    });
    if (!plan) return;

    setBusy(btn, true);
    const { data, error } = await sb
      .from("trades")
      .update({
        pair,
        direction,
        entry,
        lot_size: lotSize,
        risk_percent: riskPercent,
        rr: plan.rr,
        sl_price: slPrice,
        tp_price: tpPrice,
        risk_amount: plan.riskAmount,
        potential_profit: plan.potentialProfit,
        notes,
      })
      .eq("id", editingTradeId)
      .select()
      .single();
    setBusy(btn, false, "Save changes");

    if (error) {
      errEl.textContent = friendlySaveError(error, "Could not save changes. ");
      return;
    }
    const idx = ongoingTrades.findIndex((t) => t.id === editingTradeId);
    if (idx !== -1) ongoingTrades[idx] = normalizeTrade(data);
    closeEditModal();
    renderMain();
    showToast("Trade updated");
  });

async function deleteOngoingTrade(id) {
  const trade = ongoingTrades.find((t) => t.id === id);
  if (!trade) return;
  const sure = confirm(
    `Delete this ${trade.pair} trade? This can't be undone and won't affect your balance.`,
  );
  if (!sure) return;
  const { error } = await sb.from("trades").delete().eq("id", id);
  if (error) {
    showSaveError("Could not delete trade. " + error.message);
    return;
  }
  ongoingTrades = ongoingTrades.filter((t) => t.id !== id);
  renderMain();
  showToast(`${trade.pair} trade deleted`);
}

// ============================================================
// SWIPE-TO-REVEAL
// ============================================================
function attachSwipeHandlers() {
  document.querySelectorAll(".swipe-wrap").forEach((wrap) => {
    const inner = wrap.querySelector(".swipe-card-inner");
    const actions = wrap.querySelector(".swipe-actions");
    if (!inner || !actions) return;
    const revealWidth = actions.offsetWidth || 140;
    let startX = 0,
      currentX = 0,
      dragging = false,
      open = false;

    function setX(x) {
      currentX = Math.max(-revealWidth, Math.min(0, x));
      inner.style.transform = `translateX(${currentX}px)`;
    }

    inner.addEventListener(
      "touchstart",
      (e) => {
        dragging = true;
        startX = e.touches[0].clientX - currentX;
      },
      { passive: true },
    );
    inner.addEventListener(
      "touchmove",
      (e) => {
        if (!dragging) return;
        setX(e.touches[0].clientX - startX);
      },
      { passive: true },
    );
    inner.addEventListener("touchend", () => {
      dragging = false;
      open = currentX < -revealWidth / 2;
      setX(open ? -revealWidth : 0);
    });

    inner.addEventListener("click", (e) => {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        open = false;
        setX(0);
      }
    });
  });
}

// ============================================================
// CLOSE TRADE MODAL
// ============================================================
function openCloseModal(id) {
  closingTradeId = id;
  const trade = ongoingTrades.find((t) => t.id === id);
  if (!trade) return;
  document.getElementById("closeModalTitle").textContent =
    `Close ${trade.pair}`;
  document.getElementById("closeModalMeta").innerHTML =
    `<span>Entry ${fmtPrice(trade.entry)}</span><span>·</span>${directionTag(trade.direction)}`;
  document.getElementById("f_closePrice").value = "";
  document.getElementById("f_closePrice").placeholder = fmtPrice(trade.entry);
  document.getElementById("f_closeAmount").value = "";
  document.getElementById("closeTradeError").textContent = "";
  document.getElementById("closePreviewBox").classList.add("hidden");
  closeSyncing = false;
  lastEditedCloseField = null;

  const sliderWrap = document.getElementById("closeModalSliderWrap");
  const slBtn = document.getElementById("closeModalSlBtn");
  const tpBtn = document.getElementById("closeModalTpBtn");
  if (trade.slPrice != null && trade.tpPrice != null) {
    sliderWrap.classList.remove("hidden");
    slBtn.textContent = `SL ${fmtPrice(trade.slPrice)}`;
    tpBtn.textContent = `TP ${fmtPrice(trade.tpPrice)}`;
    slBtn.classList.remove("active");
    tpBtn.classList.remove("active");
    document.getElementById("closeModalCurrentLabel").textContent = "";
  } else {
    sliderWrap.classList.add("hidden");
  }

  document.getElementById("closeModal").classList.remove("hidden");
}
function closeCloseModal() {
  document.getElementById("closeModal").classList.add("hidden");
  closingTradeId = null;
}
document
  .getElementById("closeModalClose")
  .addEventListener("click", closeCloseModal);

function chooseExactClose(trade, exactPrice) {
  const priceInput = document.getElementById("f_closePrice");
  priceInput.value = fmtPrice(exactPrice);
  priceInput.dispatchEvent(new Event("input"));
  document.getElementById("closeModalCurrentLabel").textContent =
    fmtPrice(exactPrice);
  document
    .getElementById("closeModalSlBtn")
    .classList.toggle("active", exactPrice === trade.slPrice);
  document
    .getElementById("closeModalTpBtn")
    .classList.toggle("active", exactPrice === trade.tpPrice);
}
document.getElementById("closeModalSlBtn").addEventListener("click", () => {
  const trade = ongoingTrades.find((t) => t.id === closingTradeId);
  if (!trade || trade.slPrice == null) return;
  chooseExactClose(trade, trade.slPrice);
});
document.getElementById("closeModalTpBtn").addEventListener("click", () => {
  const trade = ongoingTrades.find((t) => t.id === closingTradeId);
  if (!trade || trade.tpPrice == null) return;
  chooseExactClose(trade, trade.tpPrice);
});

function syncCloseChoiceToPrice(trade, price) {
  if (trade.slPrice == null || trade.tpPrice == null) return;
  const label = document.getElementById("closeModalCurrentLabel");
  if (Number.isNaN(price)) {
    label.textContent = "";
    return;
  }
  label.textContent = fmtPrice(price);
  document
    .getElementById("closeModalSlBtn")
    .classList.toggle("active", price === trade.slPrice);
  document
    .getElementById("closeModalTpBtn")
    .classList.toggle("active", price === trade.tpPrice);
}

let closeSyncing = false;
let lastEditedCloseField = null;

function currentClosingTradeDpu() {
  const trade = ongoingTrades.find((t) => t.id === closingTradeId);
  if (!trade || trade.riskAmount == null || trade.slPrice == null)
    return { trade: null, dpu: null };
  const dpu = dollarsPerPriceUnit({
    riskAmount: trade.riskAmount,
    entry: trade.entry,
    slPrice: trade.slPrice,
  });
  return { trade, dpu };
}

function exactPnlAtBoundary(trade, exit) {
  if (!trade || exit == null || Number.isNaN(exit)) return null;
  if (
    trade.slPrice != null &&
    exit === trade.slPrice &&
    trade.riskAmount != null
  ) {
    return -Math.abs(trade.riskAmount);
  }
  if (
    trade.tpPrice != null &&
    exit === trade.tpPrice &&
    trade.potentialProfit != null
  ) {
    return trade.potentialProfit;
  }
  return null;
}

function showClosePreview(pnl) {
  const box = document.getElementById("closePreviewBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="preview-line"><span style="color:var(--text-faint)">Result</span><span style="font-weight:700;font-size:16px;color:${pnl < 0 ? "var(--sell)" : "var(--text)"}">${fmtMoney(pnl)}</span></div>`;
}

document.getElementById("f_closePrice").addEventListener("input", () => {
  if (closeSyncing) return;
  lastEditedCloseField = "price";
  const { trade, dpu } = currentClosingTradeDpu();
  const box = document.getElementById("closePreviewBox");
  const errEl = document.getElementById("closeTradeError");
  const exit = parseFloat(document.getElementById("f_closePrice").value);
  if (!trade || Number.isNaN(exit)) {
    box.classList.add("hidden");
    return;
  }
  const roundedExit = roundDown3(exit);
  syncCloseChoiceToPrice(trade, roundedExit);
  if (dpu === null) {
    errEl.textContent =
      "This trade has no stop-loss on record — enter the win/loss amount instead.";
    box.classList.add("hidden");
    return;
  }
  errEl.textContent = "";
  const pnl =
    exactPnlAtBoundary(trade, roundedExit) ??
    pnlFromExitPrice({
      entry: trade.entry,
      exit: roundedExit,
      direction: trade.direction,
      dollarsPerUnit: dpu,
    });
  closeSyncing = true;
  document.getElementById("f_closeAmount").value = pnl.toFixed(2);
  closeSyncing = false;
  showClosePreview(pnl);
});

document.getElementById("f_closeAmount").addEventListener("input", () => {
  if (closeSyncing) return;
  lastEditedCloseField = "amount";
  const { trade, dpu } = currentClosingTradeDpu();
  const box = document.getElementById("closePreviewBox");
  const errEl = document.getElementById("closeTradeError");
  const pnl = parseFloat(document.getElementById("f_closeAmount").value);
  if (!trade || Number.isNaN(pnl)) {
    box.classList.add("hidden");
    return;
  }
  if (dpu === null) {
    errEl.textContent =
      "This trade has no stop-loss on record — the closing price can't be derived. Just submit the amount.";
    showClosePreview(pnl);
    return;
  }
  errEl.textContent = "";
  const exit = roundToTradePrecision(
    trade,
    exitPriceFromPnl({
      entry: trade.entry,
      direction: trade.direction,
      dollarsPerUnit: dpu,
      pnl,
    }),
  );
  syncCloseChoiceToPrice(trade, exit);
  closeSyncing = true;
  document.getElementById("f_closePrice").value = fmtPrice(exit);
  closeSyncing = false;
  showClosePreview(pnl);
});

document
  .getElementById("closeTradeForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("closeTradeError");
    const btn = document.getElementById("closeTradeSubmitBtn");
    const { trade, dpu } = currentClosingTradeDpu();
    if (!trade) return;

    let exit = parseFloat(document.getElementById("f_closePrice").value);
    let pnl = parseFloat(document.getElementById("f_closeAmount").value);

    if (lastEditedCloseField === "amount" || Number.isNaN(exit)) {
      if (Number.isNaN(pnl)) {
        errEl.textContent =
          "Enter either the closing price or the win/loss amount.";
        return;
      }
      exit =
        dpu !== null
          ? roundToTradePrecision(
              trade,
              exitPriceFromPnl({
                entry: trade.entry,
                direction: trade.direction,
                dollarsPerUnit: dpu,
                pnl,
              }),
            )
          : trade.entry;
    } else {
      if (dpu === null) {
        errEl.textContent =
          "This trade has no stop-loss on record — enter the win/loss amount instead.";
        return;
      }
      pnl =
        exactPnlAtBoundary(trade, roundDown3(exit)) ??
        pnlFromExitPrice({
          entry: trade.entry,
          exit,
          direction: trade.direction,
          dollarsPerUnit: dpu,
        });
    }

    exit = roundDown3(exit);

    const balanceBefore = profile.balance;
    const balanceAfter = balanceBefore + pnl;

    setBusy(btn, true);
    const { data: updatedTrade, error: tradeErr } = await sb
      .from("trades")
      .update({
        exit,
        pnl,
        status: "closed",
        closed_at: new Date().toISOString(),
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      })
      .eq("id", trade.id)
      .select()
      .single();

    if (tradeErr) {
      setBusy(btn, false, "Close trade");
      errEl.textContent = "Could not close trade. " + tradeErr.message;
      return;
    }

    const { data: updatedProfile, error: profErr } = await sb
      .from("profiles")
      .update({ balance: balanceAfter })
      .eq("id", currentUser.id)
      .select()
      .single();

    setBusy(btn, false, "Close trade");
    if (profErr) {
      errEl.textContent =
        "Trade closed but balance update failed — refresh and check Settings. " +
        profErr.message;
    }

    profile = updatedProfile || profile;
    ongoingTrades = ongoingTrades.filter((t) => t.id !== trade.id);
    closedTrades.unshift(normalizeTrade(updatedTrade));
    closeCloseModal();
    renderMain();
    showToast(`${trade.pair} closed — ${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}`);
  });

// ============================================================
// EDIT CLOSED TRADE MODAL
// ============================================================
function currentEditingClosedTradeDpu() {
  const trade = closedTrades.find((t) => t.id === editingClosedTradeId);
  if (!trade || trade.riskAmount == null || trade.slPrice == null)
    return { trade, dpu: null };
  const dpu = dollarsPerPriceUnit({
    riskAmount: trade.riskAmount,
    entry: trade.entry,
    slPrice: trade.slPrice,
  });
  return { trade, dpu };
}

function showEditClosedPreview(pnl) {
  const box = document.getElementById("editClosedPreviewBox");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="preview-line"><span style="color:var(--text-faint)">New result</span><span style="font-weight:700;font-size:16px;color:${pnl < 0 ? "var(--sell)" : "var(--text)"}">${fmtMoney(pnl)}</span></div>`;
}

function openEditClosedModal(id) {
  if (closedTradeAlreadyEdited(id)) return;
  editingClosedTradeId = id;
  const trade = closedTrades.find((t) => t.id === id);
  if (!trade) return;
  document.getElementById("editClosedModalTitle").textContent =
    `Edit ${trade.pair}`;
  document.getElementById("editClosedModalMeta").innerHTML =
    `<span>Entry ${fmtPrice(trade.entry)}</span><span>·</span>${directionTag(trade.direction)}`;
  document.getElementById("ec_closePrice").value = trade.exit ?? "";
  document.getElementById("ec_closeAmount").value = trade.pnl ?? "";
  document.getElementById("editClosedTradeError").textContent = "";
  document.getElementById("editClosedPreviewBox").classList.add("hidden");
  closedEditSyncing = false;
  lastEditedClosedField = null;
  document.getElementById("editClosedModal").classList.remove("hidden");
}
function closeEditClosedModal() {
  document.getElementById("editClosedModal").classList.add("hidden");
  editingClosedTradeId = null;
}
document
  .getElementById("editClosedModalClose")
  .addEventListener("click", closeEditClosedModal);

document.getElementById("ec_closePrice").addEventListener("input", () => {
  if (closedEditSyncing) return;
  lastEditedClosedField = "price";
  const { trade, dpu } = currentEditingClosedTradeDpu();
  const box = document.getElementById("editClosedPreviewBox");
  const errEl = document.getElementById("editClosedTradeError");
  const exit = parseFloat(document.getElementById("ec_closePrice").value);
  if (!trade || Number.isNaN(exit)) {
    box.classList.add("hidden");
    return;
  }
  if (dpu === null) {
    errEl.textContent =
      "This trade has no stop-loss on record — update the win/loss amount instead.";
    box.classList.add("hidden");
    return;
  }
  errEl.textContent = "";
  const roundedExit = roundDown3(exit);
  const pnl =
    exactPnlAtBoundary(trade, roundedExit) ??
    pnlFromExitPrice({
      entry: trade.entry,
      exit: roundedExit,
      direction: trade.direction,
      dollarsPerUnit: dpu,
    });
  closedEditSyncing = true;
  document.getElementById("ec_closeAmount").value = pnl.toFixed(2);
  closedEditSyncing = false;
  showEditClosedPreview(pnl);
});

document.getElementById("ec_closeAmount").addEventListener("input", () => {
  if (closedEditSyncing) return;
  lastEditedClosedField = "amount";
  const { trade, dpu } = currentEditingClosedTradeDpu();
  const box = document.getElementById("editClosedPreviewBox");
  const errEl = document.getElementById("editClosedTradeError");
  const pnl = parseFloat(document.getElementById("ec_closeAmount").value);
  if (!trade || Number.isNaN(pnl)) {
    box.classList.add("hidden");
    return;
  }
  if (dpu === null) {
    errEl.textContent =
      "This trade has no stop-loss on record — the closing price can't be derived. Just submit the amount.";
    showEditClosedPreview(pnl);
    return;
  }
  errEl.textContent = "";
  const exit = roundToTradePrecision(
    trade,
    exitPriceFromPnl({
      entry: trade.entry,
      direction: trade.direction,
      dollarsPerUnit: dpu,
      pnl,
    }),
  );
  closedEditSyncing = true;
  document.getElementById("ec_closePrice").value = fmtPrice(exit);
  closedEditSyncing = false;
  showEditClosedPreview(pnl);
});

document
  .getElementById("editClosedTradeForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("editClosedTradeError");
    const btn = document.getElementById("editClosedTradeSubmitBtn");
    const { trade, dpu } = currentEditingClosedTradeDpu();
    if (!trade) return;
    if (closedTradeAlreadyEdited(trade.id)) {
      errEl.textContent = "This trade has already used its one edit.";
      return;
    }

    let exit = parseFloat(document.getElementById("ec_closePrice").value);
    let pnl = parseFloat(document.getElementById("ec_closeAmount").value);

    if (lastEditedClosedField === "amount" || Number.isNaN(exit)) {
      if (Number.isNaN(pnl)) {
        errEl.textContent =
          "Enter either the closing price or the win/loss amount.";
        return;
      }
      exit =
        dpu !== null
          ? roundToTradePrecision(
              trade,
              exitPriceFromPnl({
                entry: trade.entry,
                direction: trade.direction,
                dollarsPerUnit: dpu,
                pnl,
              }),
            )
          : trade.exit;
    } else {
      if (dpu === null) {
        if (Number.isNaN(pnl)) {
          errEl.textContent =
            "This trade has no stop-loss on record — enter the win/loss amount instead.";
          return;
        }
      } else {
        pnl =
          exactPnlAtBoundary(trade, roundDown3(exit)) ??
          pnlFromExitPrice({
            entry: trade.entry,
            exit,
            direction: trade.direction,
            dollarsPerUnit: dpu,
          });
      }
    }

    exit = roundDown3(exit);
    const pnlDelta = pnl - trade.pnl;
    const balanceAfter = profile.balance + pnlDelta;

    setBusy(btn, true);
    const { data: updatedTrade, error: tradeErr } = await sb
      .from("trades")
      .update({
        exit,
        pnl,
        balance_after: balanceAfter,
      })
      .eq("id", trade.id)
      .select()
      .single();

    if (tradeErr) {
      setBusy(btn, false, "Save changes");
      errEl.textContent = friendlySaveError(
        tradeErr,
        "Could not save changes. ",
      );
      return;
    }

    const { data: updatedProfile, error: profErr } = await sb
      .from("profiles")
      .update({ balance: balanceAfter })
      .eq("id", currentUser.id)
      .select()
      .single();

    setBusy(btn, false, "Save changes");
    if (profErr) {
      errEl.textContent =
        "Trade updated but balance sync failed — refresh and check Settings. " +
        profErr.message;
    }

    profile = updatedProfile || profile;
    const idx = closedTrades.findIndex((t) => t.id === trade.id);
    if (idx !== -1) closedTrades[idx] = normalizeTrade(updatedTrade);
    markClosedTradeEdited(trade.id);
    closeEditClosedModal();
    renderMain();
    showToast(`${trade.pair} closed trade updated`);
  });

// ============================================================
// ADD CLOSED TRADE MODAL
// ============================================================
let closedFormDirection = "Buy";
let selectedMoodTags = [];

function localDatetimeNowValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function openAddClosedModal() {
  document.getElementById("addClosedTradeForm").reset();
  document.getElementById("addClosedTradeError").textContent = "";
  closedFormDirection = "Buy";
  document.getElementById("c_direction").value = "Buy";
  document.getElementById("c_pair").value = "";
  document.getElementById("c_pairDropdown").classList.add("hidden");
  document
    .querySelectorAll("#addClosedTradeForm .dir-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.closedir === "Buy"));
  document.getElementById("c_closedAt").value = localDatetimeNowValue();
  selectedMoodTags = [];
  document
    .querySelectorAll(".mood-tag-btn")
    .forEach((b) => b.classList.remove("active"));
  document.getElementById("addClosedPreviewBox").classList.add("hidden");
  document.getElementById("addClosedModal").classList.remove("hidden");
}
function closeAddClosedModal() {
  document.getElementById("addClosedModal").classList.add("hidden");
}
document
  .getElementById("addClosedModalClose")
  .addEventListener("click", closeAddClosedModal);

document.querySelectorAll("#addClosedTradeForm .dir-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    closedFormDirection = btn.dataset.closedir;
    document.getElementById("c_direction").value = closedFormDirection;
    document
      .querySelectorAll("#addClosedTradeForm .dir-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.querySelectorAll(".mood-tag-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
    const mood = btn.dataset.mood;
    if (btn.classList.contains("active")) {
      if (!selectedMoodTags.includes(mood)) selectedMoodTags.push(mood);
    } else {
      selectedMoodTags = selectedMoodTags.filter((m) => m !== mood);
    }
  });
});

function updateAddClosedPreview() {
  const pnl = parseFloat(document.getElementById("c_pnl").value);
  const box = document.getElementById("addClosedPreviewBox");
  if (Number.isNaN(pnl)) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `
      <div class="preview-line"><span style="color:var(--text-faint)">New balance</span><span style="font-weight:700;color:${pnl < 0 ? "var(--sell)" : "var(--text)"}">${fmtMoney(profile.balance + pnl)}</span></div>
    `;
}
document
  .getElementById("c_pnl")
  .addEventListener("input", updateAddClosedPreview);

document
  .getElementById("addClosedTradeForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("addClosedTradeError");
    const btn = document.getElementById("addClosedTradeSubmitBtn");
    errEl.textContent = "";

    const pair = document.getElementById("c_pair").value.trim().toUpperCase();
    const direction = document.getElementById("c_direction").value;
    const entry = parseFloat(document.getElementById("c_entry").value);
    const exit = parseFloat(document.getElementById("c_exit").value);
    const lotSize = parseFloat(document.getElementById("c_lot").value);
    const pnl = parseFloat(document.getElementById("c_pnl").value);
    const closedAtInput = document.getElementById("c_closedAt").value;
    let notes = document.getElementById("c_notes").value.trim();

    if (
      !pair ||
      Number.isNaN(entry) ||
      Number.isNaN(exit) ||
      Number.isNaN(lotSize) ||
      Number.isNaN(pnl) ||
      !closedAtInput
    ) {
      errEl.textContent = "Fill in all required fields.";
      return;
    }

    const closedAtIso = new Date(closedAtInput).toISOString();
    const balanceBefore = profile.balance;
    const balanceAfter = balanceBefore + pnl;

    setBusy(btn, true);
    const { data: insertedTrade, error: tradeErr } = await sb
      .from("trades")
      .insert({
        user_id: currentUser.id,
        pair,
        direction,
        entry,
        exit,
        lot_size: lotSize,
        risk_percent: 0,
        rr: 0,
        sl_price: null,
        tp_price: null,
        risk_amount: 0,
        potential_profit: 0,
        pnl,
        notes,
        mood_tags: [...selectedMoodTags],
        status: "closed",
        closed_at: closedAtIso,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      })
      .select()
      .single();

    if (tradeErr) {
      setBusy(btn, false, "Save closed trade");
      errEl.textContent = friendlySaveError(
        tradeErr,
        "Could not save closed trade. ",
      );
      return;
    }

    const { data: updatedProfile, error: profErr } = await sb
      .from("profiles")
      .update({ balance: balanceAfter })
      .eq("id", currentUser.id)
      .select()
      .single();

    setBusy(btn, false, "Save closed trade");
    if (profErr) {
      errEl.textContent =
        "Trade saved but balance update failed — refresh and check Settings. " +
        profErr.message;
    }

    profile = updatedProfile || profile;
    closedTrades.unshift(normalizeTrade(insertedTrade));
    closeAddClosedModal();
    renderMain();
    showToast(
      `${pair} closed trade logged — ${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}`,
    );
  });

// ============================================================
// WELCOME TOUR
// ============================================================
const TOUR_KEY = "tradebook_tour_v1_done";
const TOUR_STEPS = [
  {
    target: ".greeting",
    title: "Welcome to Tradebook",
    body: "This is home base — your balance, your results, and every trade you log all live here.",
  },
  {
    target: "#openAddBtn",
    title: "Plan a new trade",
    body: "Set your entry, stop loss, and take profit before you're in it — Tradebook works out your risk and reward for you.",
  },
  {
    target: "#openAddClosedBtn",
    title: "Already closed the trade?",
    body: "Skip the planning step. Log a trade you already took — pair, entry/exit, and the win or loss — straight into your history.",
  },
  {
    target: ".weekly-recap-card",
    title: "Your weekly recap",
    body: "A quick pulse check on the last 7 days: net P&L, win rate, and the pair you traded most.",
  },
  {
    target: ".bottomnav",
    title: "Everything else lives here",
    body: "Trades for your full history, Performance for the deeper numbers, and Settings whenever you need them.",
  },
];

let tourActive = false;
let tourStepIndex = 0;

function ensureTourLayer() {
  let layer = document.getElementById("tourLayer");
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = "tourLayer";
  layer.innerHTML = `
      <div class="tour-highlight" id="tourHighlight"></div>
      <div class="tour-tooltip" id="tourTooltip">
        <div class="tour-tooltip-head">
          <span class="tour-tooltip-step" id="tourStepLabel"></span>
          <button type="button" class="tour-skip-btn" id="tourSkipBtn">Skip tour</button>
        </div>
        <div class="tour-tooltip-title" id="tourTitle"></div>
        <div class="tour-tooltip-body" id="tourBody"></div>
        <div class="tour-tooltip-footer">
          <div class="tour-progress-dots" id="tourDots"></div>
          <div class="tour-nav-btns">
            <button type="button" class="btn-outline" id="tourBackBtn" style="width:auto;padding:7px 14px;font-size:12px;">Back</button>
            <button type="button" class="btn-primary" id="tourNextBtn" style="width:auto;padding:7px 16px;font-size:12px;">Next</button>
          </div>
        </div>
      </div>`;
  document.body.appendChild(layer);
  document
    .getElementById("tourSkipBtn")
    .addEventListener("click", () => endTour(true));
  document.getElementById("tourBackBtn").addEventListener("click", () => {
    tourStepIndex = Math.max(0, tourStepIndex - 1);
    renderTourStep();
  });
  document.getElementById("tourNextBtn").addEventListener("click", () => {
    if (tourStepIndex >= TOUR_STEPS.length - 1) {
      endTour(true);
    } else {
      tourStepIndex++;
      renderTourStep();
    }
  });
  return layer;
}

function startTour() {
  if (currentTab !== "home") {
    currentTab = "home";
    document
      .querySelectorAll(".nav-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === "home"));
    renderMain();
  }
  ensureTourLayer().classList.add("active");
  tourActive = true;
  tourStepIndex = 0;
  renderTourStep();
  window.addEventListener("resize", repositionTourStep);
}

function endTour(markDone) {
  tourActive = false;
  const layer = document.getElementById("tourLayer");
  if (layer) layer.classList.remove("active");
  if (markDone) localStorage.setItem(TOUR_KEY, "1");
  window.removeEventListener("resize", repositionTourStep);
}

function renderTourStep() {
  const step = TOUR_STEPS[tourStepIndex];
  const target = step ? document.querySelector(step.target) : null;
  if (!step || !target) {
    if (tourStepIndex < TOUR_STEPS.length - 1) {
      tourStepIndex++;
      renderTourStep();
    } else {
      endTour(true);
    }
    return;
  }
  document.getElementById("tourStepLabel").textContent =
    `${tourStepIndex + 1} of ${TOUR_STEPS.length}`;
  document.getElementById("tourTitle").textContent = step.title;
  document.getElementById("tourBody").textContent = step.body;
  document.getElementById("tourBackBtn").style.visibility =
    tourStepIndex === 0 ? "hidden" : "visible";
  document.getElementById("tourNextBtn").textContent =
    tourStepIndex === TOUR_STEPS.length - 1 ? "Got it" : "Next";
  document.getElementById("tourDots").innerHTML = TOUR_STEPS.map(
    (_, i) =>
      `<span class="tour-dot ${i === tourStepIndex ? "active" : ""}"></span>`,
  ).join("");
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  positionTour(target);
  setTimeout(() => {
    if (tourActive) positionTour(target);
  }, 260);
}

function repositionTourStep() {
  if (!tourActive) return;
  const step = TOUR_STEPS[tourStepIndex];
  const target = step ? document.querySelector(step.target) : null;
  if (target) positionTour(target);
}

function positionTour(target) {
  const rect = target.getBoundingClientRect();
  const pad = 8;
  const highlight = document.getElementById("tourHighlight");
  highlight.style.top = `${rect.top - pad}px`;
  highlight.style.left = `${rect.left - pad}px`;
  highlight.style.width = `${rect.width + pad * 2}px`;
  highlight.style.height = `${rect.height + pad * 2}px`;

  const tooltip = document.getElementById("tourTooltip");
  const tw = tooltip.offsetWidth || 280;
  const th = tooltip.offsetHeight || 150;
  const gap = 14;
  let top = rect.bottom + gap;
  if (top + th > window.innerHeight - 12) {
    top = rect.top - th - gap;
  }
  if (top < 12) top = 12;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

boot();
