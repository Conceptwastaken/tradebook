// ============================================================
// AUTH.JS — pairs with the trimmed onboarding.html
// Handles: login, signup, OTP verification, Google OAuth.
// Job ends the moment a session exists: redirect to the app
// subdomain and let app.js take over from there (including the
// first-time balance setup screen — that now lives on the app
// domain, not here).
// ============================================================

// >>> CHANGE THIS to your actual app subdomain if different <<<
const APP_URL = "https://app.tradebook.com.ng";

// ---------- cross-subdomain session storage ----------
// Supabase's default (localStorage) is scoped per-origin, so a session
// created on tradebook.com.ng is invisible on app.tradebook.com.ng and
// vice versa -- this caused the login/app redirect loop. Storing the
// session in a cookie scoped to .tradebook.com.ng fixes that, since
// cookies with a leading-dot domain are shared across all subdomains.
const COOKIE_DOMAIN = ".tradebook.com.ng";

function setCookie(name, value, days = 7) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; domain=${COOKIE_DOMAIN}; SameSite=Lax; Secure`;
}
function getCookie(name) {
  const match = document.cookie.match(
    new RegExp(
      "(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)",
    ),
  );
  return match ? decodeURIComponent(match[1]) : null;
}
function removeCookie(name) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${COOKIE_DOMAIN}`;
}

const cookieStorage = {
  getItem: (key) => getCookie(key),
  setItem: (key, value) => setCookie(key, value),
  removeItem: (key) => removeCookie(key),
};

const SUPABASE_URL = "https://ekgsklyozoftzrpzqsqg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable__qcdvIHMqdNS67Awe8D2rg_ORrH0ObY";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: cookieStorage,
    persistSession: true,
    autoRefreshToken: true,
  },
});

function showOnly(id) {
  ["loadingScreen", "authScreen", "verifiedScreen"].forEach((s) => {
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
    showOnly("authScreen");
    const el = document.getElementById("loginError");
    if (el)
      el.textContent =
        "Something went wrong loading Tradebook. Please refresh.";
  }
}

async function bootInner() {
  showOnly("loadingScreen");

  // If we've landed here straight from an email confirmation or OAuth
  // redirect, the URL hash carries the auth tokens and supabase-js
  // needs a moment to parse them into a session.
  const hash = window.location.hash;
  const isEmailConfirmation =
    hash.includes("access_token") && hash.includes("type=signup");
  if (hash.includes("access_token")) {
    await new Promise((resolve) => {
      const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
        if (session) {
          sub.subscription.unsubscribe();
          resolve();
        }
      });
      setTimeout(resolve, 2500);
    });
    history.replaceState(null, "", window.location.pathname);
  }

  const {
    data: { session },
  } = await sb.auth.getSession();

  if (isEmailConfirmation) {
    // Fresh email confirmation — show the success screen and let the
    // person continue on their own terms, rather than redirecting
    // them away immediately.
    showOnly("verifiedScreen");
    return;
  }

  if (session) {
    // Already logged in — auth's job is done, hand off to the app.
    window.location.href = APP_URL;
    return;
  }

  showOnly("authScreen");
}

document.getElementById("verifiedContinueBtn").addEventListener("click", () => {
  window.location.href = APP_URL;
});

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

// ---------- auth tab switching ----------
document.querySelectorAll(".auth-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".auth-tab-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    document
      .getElementById("loginForm")
      .classList.toggle("hidden", btn.dataset.authtab !== "login");
    document
      .getElementById("signupForm")
      .classList.toggle("hidden", btn.dataset.authtab !== "signup");
    document.getElementById("otpForm").classList.add("hidden");
  });
});

// ---------- password show/hide ----------
const EYE_OPEN_PATH = "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z";
const EYE_CLOSED_PATH =
  "M3 3l18 18M10.6 10.6a3 3 0 004.24 4.24M9.9 4.24A11 11 0 0112 4c7 0 11 7 11 7a17.6 17.6 0 01-3.22 4.19M6.5 6.32C3.6 8.06 1 12 1 12s4 7 11 7a10.9 10.9 0 004.5-.96";
document.querySelectorAll("[data-toggle-pw]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.togglePw);
    const icon = btn.querySelector("svg");
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn.setAttribute(
      "aria-label",
      isHidden ? "Hide password" : "Show password",
    );
    icon.innerHTML = isHidden
      ? `<path d="${EYE_CLOSED_PATH}"/>`
      : `<path d="${EYE_OPEN_PATH}"/><circle cx="12" cy="12" r="3"/>`;
  });
});

// ---------- password strength ----------
function scorePassword(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score; // 0-5
}
document.getElementById("signupPassword").addEventListener("input", (e) => {
  const pw = e.target.value;
  const score = scorePassword(pw);
  const fill = document.getElementById("pwStrengthFill");
  const label = document.getElementById("pwStrengthLabel");
  if (!pw) {
    fill.style.width = "0%";
    label.textContent = "";
    return;
  }
  const pct = Math.min(100, (score / 5) * 100);
  fill.style.width = pct + "%";
  if (score <= 2) {
    fill.style.background = "var(--sell)";
    label.textContent = "Weak password";
    label.style.color = "var(--sell)";
  } else if (score <= 3) {
    fill.style.background = "#d9a02a";
    label.textContent = "Okay password";
    label.style.color = "#d9a02a";
  } else {
    fill.style.background = "#2e9e5b";
    label.textContent = "Strong password";
    label.style.color = "#2e9e5b";
  }
});

// ---------- Google OAuth ----------
document.getElementById("googleAuthBtn").addEventListener("click", async () => {
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Lands back on THIS page (onboarding.html) — bootInner() above
      // will see the fresh session and redirect to APP_URL on its own.
      redirectTo: window.location.origin + "/onboarding.html",
    },
  });
});

// ---------- signup ----------
let pendingSignupEmail = "";
document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("signupName").value.trim();
  const email = document
    .getElementById("signupEmail")
    .value.trim()
    .toLowerCase();
  const password = document.getElementById("signupPassword").value;
  const errEl = document.getElementById("signupError");
  const infoEl = document.getElementById("signupInfo");
  const btn = document.getElementById("signupSubmitBtn");
  errEl.textContent = "";
  infoEl.textContent = "";
  setBusy(btn, true);

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  setBusy(btn, false, "Create account");

  if (error) {
    errEl.textContent = error.message;
    return;
  }
  if (!data.session) {
    // No session yet — Supabase requires email confirmation. Switch
    // to the 6-digit code form instead of relying on a clickable
    // link. The Confirm Signup email template must include
    // {{ .Token }} for the code to actually be in the email.
    pendingSignupEmail = email;
    document.getElementById("otpEmailLabel").textContent = email;
    document.getElementById("signupForm").classList.add("hidden");
    document.getElementById("otpForm").classList.remove("hidden");
    document.getElementById("otpError").textContent = "";
    document.getElementById("otpCode").value = "";
    return;
  }
  // Session exists immediately (email confirmation disabled) — hand
  // off to the app straight away.
  window.location.href = APP_URL;
});

document.getElementById("otpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("otpCode").value.trim();
  const errEl = document.getElementById("otpError");
  const btn = document.getElementById("otpSubmitBtn");
  errEl.textContent = "";
  if (!code) return;
  setBusy(btn, true);

  const { data, error } = await sb.auth.verifyOtp({
    email: pendingSignupEmail,
    token: code,
    type: "signup",
  });
  setBusy(btn, false, "Verify email");

  if (error) {
    errEl.textContent = error.message;
    return;
  }
  window.location.href = APP_URL;
});

document.getElementById("otpResendBtn").addEventListener("click", async () => {
  const errEl = document.getElementById("otpError");
  const btn = document.getElementById("otpResendBtn");
  errEl.textContent = "";
  if (!pendingSignupEmail) return;
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Sending…";
  const { error } = await sb.auth.resend({
    type: "signup",
    email: pendingSignupEmail,
  });
  btn.disabled = false;
  btn.textContent = prevLabel;
  errEl.textContent = error
    ? error.message
    : "New code sent — check your email.";
  errEl.style.color = error ? "" : "var(--text-dim)";
});

// ---------- login ----------
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document
    .getElementById("loginEmail")
    .value.trim()
    .toLowerCase();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  const btn = document.getElementById("loginSubmitBtn");
  errEl.textContent = "";
  setBusy(btn, true);

  const { data, error } = await sb.auth.signInWithPassword({
    email,
    password,
  });
  setBusy(btn, false, "Log in");

  if (error) {
    errEl.textContent = error.message;
    return;
  }
  window.location.href = APP_URL;
});

boot();
