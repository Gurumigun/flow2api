const ALARM_NAME = "flow2api-token-refresh";
const FLOW_URL = "https://flow.google.com/";
const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:8000/api/plugin/update-token",
  connectionToken: "",
  refreshInterval: 360,
  loginAccount: ""
};
const LABS_SESSION_COOKIE_NAMES = new Set([
  "__Secure-next-auth.session-token",
  "next-auth.session-token"
]);
const GOOGLE_PROTOCOL_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "SIDCC",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC"
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForTabReady(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || (tab && tab.status === "complete")) finish();
    });
  });
}

async function findOrOpenFlowTab() {
  const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
  const existing = tabs.find((tab) => Number.isInteger(tab.id));
  if (existing) return { tab: existing, created: false };
  const tab = await chrome.tabs.create({ url: FLOW_URL, active: false });
  return { tab, created: true };
}

async function collectCookies() {
  const batches = await Promise.all([
    chrome.cookies.getAll({ url: "https://labs.google/fx/tools/flow" }),
    chrome.cookies.getAll({ domain: "labs.google" }),
    chrome.cookies.getAll({ url: "https://accounts.google.com/" }),
    chrome.cookies.getAll({ domain: "google.com" })
  ]);
  const unique = new Map();
  for (const cookie of batches.flat()) {
    const key = [cookie.storeId || "", cookie.name, cookie.domain, cookie.path].join("|");
    unique.set(key, cookie);
  }
  return Array.from(unique.values());
}

function serializeProtocolCookies(cookies) {
  return JSON.stringify(
    cookies
      .filter((cookie) => GOOGLE_PROTOCOL_COOKIE_NAMES.has(cookie.name) && cookie.value)
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite || "unspecified",
        expirationDate: cookie.expirationDate || null
      }))
  );
}

async function readServerError(response) {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text);
    return String(payload.detail || payload.message || text);
  } catch (_) {
    return text;
  }
}

async function extractAndSendToken() {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const apiUrl = String(config.apiUrl || "").trim();
  const connectionToken = String(config.connectionToken || "").trim();
  if (!apiUrl || !connectionToken) {
    return { success: false, error: "연결 주소와 연결 Token을 먼저 저장하세요." };
  }

  let opened = null;
  try {
    opened = await findOrOpenFlowTab();
    await waitForTabReady(opened.tab.id);
    await sleep(1200);

    const cookies = await collectCookies();
    const labsSession = cookies.find(
      (cookie) => LABS_SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value
    );
    const googleCookies = serializeProtocolCookies(cookies);
    const parsedGoogleCookies = JSON.parse(googleCookies);
    if (!labsSession && parsedGoogleCookies.length === 0) {
      return {
        success: false,
        error: "Session Token과 프로토콜 갱신용 Google 쿠키를 찾지 못했습니다. 같은 Chrome 프로필에서 Google Flow에 로그인하세요."
      };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${connectionToken}`
      },
      body: JSON.stringify({
        session_token: labsSession ? labsSession.value : null,
        google_cookies: parsedGoogleCookies.length ? googleCookies : null,
        protocol_mode: parsedGoogleCookies.length ? "protocol" : "session",
        login_account: String(config.loginAccount || "").trim() || null
      })
    });
    if (!response.ok) {
      return { success: false, error: await readServerError(response) };
    }

    const result = await response.json();
    return {
      success: true,
      action: result.action,
      message: result.message || "Token 동기화 완료",
      usedProtocolFallback: !labsSession
    };
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : String(error) };
  } finally {
    if (opened && opened.created && opened.tab && Number.isInteger(opened.tab.id)) {
      try {
        await chrome.tabs.remove(opened.tab.id);
      } catch (_) {
        // The user or browser may already have closed the temporary tab.
      }
    }
  }
}

async function configureAlarm() {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const interval = Math.max(30, Number(config.refreshInterval) || 360);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
}

chrome.runtime.onInstalled.addListener(() => {
  configureAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) extractAndSendToken().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.action === "configUpdated") {
    configureAlarm().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message && message.action === "testNow") {
    extractAndSendToken().then(sendResponse);
    return true;
  }
  return false;
});
