const DEFAULT_CONFIG = {
  apiUrl: "http://127.0.0.1:8000/api/plugin/update-token",
  connectionToken: "",
  refreshInterval: 360,
  loginAccount: ""
};

const element = (id) => document.getElementById(id);

function showStatus(message, isError = false) {
  const status = element("status");
  status.textContent = message;
  status.className = isError ? "error" : "ok";
}

function apiOriginPattern(apiUrl) {
  const parsed = new URL(apiUrl);
  return `${parsed.origin}/*`;
}

async function ensureApiPermission(apiUrl) {
  const origins = [apiOriginPattern(apiUrl)];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function loadConfig() {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  element("apiUrl").value = config.apiUrl || DEFAULT_CONFIG.apiUrl;
  element("connectionToken").value = config.connectionToken || "";
  element("refreshInterval").value = Math.max(30, Number(config.refreshInterval) || 360);
  element("loginAccount").value = config.loginAccount || "";
}

async function saveConfig() {
  const apiUrl = element("apiUrl").value.trim();
  const connectionToken = element("connectionToken").value.trim();
  const refreshInterval = Math.max(30, Number(element("refreshInterval").value) || 360);
  const loginAccount = element("loginAccount").value.trim();
  if (!apiUrl || !connectionToken) {
    showStatus("연결 주소와 연결 Token을 입력하세요.", true);
    return;
  }
  try {
    const parsed = new URL(apiUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("invalid protocol");
  } catch (_) {
    showStatus("연결 주소는 http:// 또는 https:// URL이어야 합니다.", true);
    return;
  }
  if (!await ensureApiPermission(apiUrl)) {
    showStatus("Flow2API 서버 주소 접근 권한이 필요합니다.", true);
    return;
  }
  await chrome.storage.sync.set({ apiUrl, connectionToken, refreshInterval, loginAccount });
  await chrome.runtime.sendMessage({ action: "configUpdated" });
  showStatus("설정을 저장했습니다.");
}

async function testNow() {
  element("test").disabled = true;
  showStatus("Token을 확인하고 있습니다…");
  try {
    const apiUrl = element("apiUrl").value.trim();
    if (!apiUrl || !await ensureApiPermission(apiUrl)) {
      showStatus("Flow2API 서버 주소 접근 권한이 필요합니다.", true);
      return;
    }
    const result = await chrome.runtime.sendMessage({ action: "testNow" });
    if (!result || !result.success) {
      showStatus(`테스트 실패: ${(result && result.error) || "알 수 없는 오류"}`, true);
      return;
    }
    const fallback = result.usedProtocolFallback ? "\nGoogle 쿠키 교환 방식을 사용했습니다." : "";
    showStatus(`테스트 성공: ${result.message}${fallback}`);
  } catch (error) {
    showStatus(`테스트 실패: ${error.message || error}`, true);
  } finally {
    element("test").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadConfig().catch((error) => showStatus(error.message || String(error), true));
  element("save").addEventListener("click", () => saveConfig().catch((error) => showStatus(error.message || String(error), true)));
  element("test").addEventListener("click", testNow);
});
