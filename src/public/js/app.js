import { detectLanguage, loadLanguage } from "./i18n.js";

const TOKEN_KEY = "webex-dashboard.token";
const IGNORED_ALERTS_KEY = "webex-dashboard.ignored-alerts";
const SEEN_ALERTS_KEY = "webex-dashboard.seen-alerts";
let token = localStorage.getItem(TOKEN_KEY) || "";
let t = (k) => k;
let devices = [];
let events = [];
const selectedTags = new Set();
const selectedTypes = new Set();
const ignoredAlertIds = new Set(JSON.parse(localStorage.getItem(IGNORED_ALERTS_KEY) || "[]"));
const seenAlertIds = new Set(JSON.parse(localStorage.getItem(SEEN_ALERTS_KEY) || "[]"));
let route = "dashboard";
let selectedStatusFilter = "all";
let lastRenderedAlertIds = [];

const STATUS_FILTERS = [
  { id: "offline", className: "offline", key: "filters.offline" },
  { id: "online", className: "online", key: "filters.online" },
  { id: "in_call", className: "in-call", key: "filters.inCall" },
  { id: "only_with_issues", className: "issues", key: "filters.onlyWithIssues" },
  { id: "in_call_with_issues", className: "issues", key: "filters.inCallWithIssues" }
];

const els = {
  loginForm: document.getElementById("login-form"),
  email: document.getElementById("email"),
  authPanel: document.getElementById("auth-panel"),
  authError: document.getElementById("auth-error"),
  devices: document.getElementById("devices"),
  devicesEmpty: document.getElementById("devices-empty"),
  alertsList: document.getElementById("alerts-list"),
  alertsNewBadge: document.getElementById("alerts-new-badge"),
  alertsClearAll: document.getElementById("alerts-clear-all"),
  stats: document.getElementById("stats"),
  language: document.getElementById("language"),
  tagFilters: document.getElementById("tag-filters"),
  tagFiltersAlerts: document.getElementById("tag-filters-alerts"),
  tagFiltersSide: document.getElementById("tag-filters-side"),
  clearTags: document.getElementById("clear-tags"),
  clearTagsAlerts: document.getElementById("clear-tags-alerts"),
  statusFilters: document.getElementById("status-filters"),
  typeFilters: document.getElementById("type-filters"),
  sideLinks: [...document.querySelectorAll(".side-link")],
  pages: {
    dashboard: document.getElementById("page-dashboard"),
    devices: document.getElementById("page-devices"),
    alerts: document.getElementById("page-alerts")
  }
};

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

function showAuthError(messageKey = "") {
  els.authError.textContent = messageKey ? t(messageKey) : "";
}

function resetAuth(messageKey = "") {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  els.authPanel.style.display = "block";
  showAuthError(messageKey);
}

function minutesSince(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(diff / 60_000));
}

function secondsSince(isoDate) {
  if (!isoDate) {
    return null;
  }
  const diff = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(diff / 1000));
}

function formatKbps(value) {
  if (value === undefined || value === null) {
    return "-";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} Mbps`;
  }
  return `${Number(value).toFixed(0)} kbps`;
}

function formatMeetingTimeRange(meeting) {
  if (!meeting?.startAt) {
    return t("devices.noNextMeeting");
  }

  const start = new Date(meeting.startAt);
  const end = meeting.endAt ? new Date(meeting.endAt) : null;
  const dayFormatter = new Intl.DateTimeFormat(document.documentElement.lang || navigator.language, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const timeFormatter = new Intl.DateTimeFormat(document.documentElement.lang || navigator.language, {
    hour: "2-digit",
    minute: "2-digit"
  });

  const dateLabel = dayFormatter.format(start);
  const startLabel = timeFormatter.format(start);
  const endLabel = end ? timeFormatter.format(end) : null;
  return endLabel ? `${dateLabel} ${startLabel} - ${endLabel}` : `${dateLabel} ${startLabel}`;
}

function getNextMeetingLabel(device) {
  if (device?.nextMeeting?.startAt) {
    return formatMeetingTimeRange(device.nextMeeting);
  }
  if (String(device?.bookingStatus || "").toLowerCase() === "freeuntil") {
    return t("devices.nextMeetingDetected");
  }
  return t("devices.noNextMeeting");
}

function metricLevel(metric, value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return "qos-na";
  }
  const n = Number(value);
  if (metric === "packetLossPct") {
    if (n < 3) return "qos-good";
    if (n < 5) return "qos-ok";
    return "qos-bad";
  }
  if (metric === "jitterMs") {
    if (n < 100) return "qos-good";
    if (n < 150) return "qos-ok";
    return "qos-bad";
  }
  if (metric === "latencyMs") {
    if (n < 300) return "qos-good";
    if (n < 400) return "qos-ok";
    return "qos-bad";
  }
  return "qos-na";
}

function getAvailableTags() {
  return [...new Set(getDisplayDevices().flatMap((d) => d.tags || []).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function getFilteredDevices() {
  return getDisplayDevices().filter((d) => matchesActiveFilters(d));
}

function isRoomNavigator(device) {
  return String(device?.product || "").toLowerCase().includes("room navigator");
}

function getAssociatedNavigators(device) {
  if (!device?.roomId) {
    return [];
  }
  return devices.filter((candidate) => candidate.roomId === device.roomId && isRoomNavigator(candidate));
}

function getDisplayDevices() {
  return devices.filter((d) => !isRoomNavigator(d));
}

function matchesActiveFilters(device) {
  const tags = new Set(device.tags || []);
  for (const wanted of selectedTags) {
    if (!tags.has(wanted)) {
      return false;
    }
  }
  if (selectedTypes.size > 0 && !selectedTypes.has(device.product || "")) {
    return false;
  }
  if (selectedStatusFilter === "all") {
    return true;
  }
  return matchStatusFilter(device, selectedStatusFilter);
}

function hasIssues(device) {
  return Array.isArray(device.faults) && device.faults.length > 0;
}

function matchStatusFilter(device, filterId) {
  const issues = hasIssues(device);
  switch (filterId) {
    case "offline":
      return device.status === "offline";
    case "online":
      return device.status === "online" && !device.inCall && !issues;
    case "in_call":
      return device.inCall && !issues;
    case "only_with_issues":
      return !device.inCall && issues;
    case "in_call_with_issues":
      return device.inCall && issues;
    default:
      return true;
  }
}

function getDeviceBadge(device) {
  const issues = hasIssues(device);
  const platform = String(device.meetingPlatform || "").toLowerCase();
  const protocol = String(device.callProtocol || "").toLowerCase();
  if (device.inCall && issues) {
    return { className: "in-call-issues", label: getInCallLabel(platform, protocol) };
  }
  if (device.inCall) {
    return { className: "in-call", label: getInCallLabel(platform, protocol) };
  }
  if (device.status === "offline") {
    return { className: "offline", label: t("devices.badgeOffline") };
  }
  if (issues) {
    return { className: "online-issues", label: t("devices.badgeOnlineWithIssues") };
  }
  return { className: "online", label: t("devices.badgeOnline") };
}

function getInCallLabel(platform, protocol) {
  if (platform === "googlemeet") {
    return t("devices.platformGoogleMeet");
  }
  if (platform === "zoom") {
    return t("devices.platformZoom");
  }
  if (platform === "microsoftteams") {
    return t("devices.platformMicrosoftTeams");
  }
  if (platform === "webex") {
    return t("devices.platformWebex");
  }
  if (protocol === "webrtc") {
    return t("devices.platformWebRTC");
  }
  return t("devices.callStatusGeneric");
}

function isMeetingRoomDevice(device) {
  const product = String(device?.product || "").toLowerCase();
  return (
    !!device?.booked ||
    device?.used !== undefined ||
    !!device?.nextMeeting ||
    product.includes("desk") ||
    product.includes("room") ||
    product.includes("board") ||
    product.includes("navigator")
  );
}

function getBookingStatus(device) {
  const bookingStatus = String(device.bookingStatus || "").toLowerCase();
  if (device.booked === true) {
    return t("devices.bookedUntil");
  }
  if (bookingStatus === "freeuntil" || device.booked === false) {
    return t("devices.freeUntil");
  }
  return t("devices.unknownAvailability");
}

function faultClass(fault) {
  const code = String(fault?.code || "").toLowerCase();
  const message = String(fault?.message || "").toLowerCase();
  if (code.includes("possible_crash") || message.includes("possible crash") || fault?.severity === "critical") {
    return "fault-critical";
  }
  if (fault?.severity === "info") {
    return "fault-info";
  }
  return "fault-warning";
}

function shouldShowFault(device, fault) {
  const combined = `${fault?.code || ""} ${fault?.message || ""}`.toLowerCase();
  if (
    device.status !== "offline" &&
    (combined.includes("device is now offline") ||
      combined.includes("device went offline") ||
      combined.includes("online/offline"))
  ) {
    return false;
  }
  return true;
}

function renderTagFilters() {
  const tags = getAvailableTags();
  const html = tags
    .map(
      (tag) =>
        `<button type="button" class="tag-chip ${selectedTags.has(tag) ? "active" : ""}" data-tag="${tag}">${tag}</button>`
    )
    .join("");
  els.tagFilters.innerHTML = html;
  if (els.tagFiltersAlerts) {
    els.tagFiltersAlerts.innerHTML = html;
  }
  if (els.tagFiltersSide) {
    els.tagFiltersSide.innerHTML = html;
  }
}

function renderStatusFilters() {
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f.id, getDisplayDevices().filter((d) => matchStatusFilter(d, f.id)).length])
  );
  els.statusFilters.innerHTML = STATUS_FILTERS.map((f) => {
    const active = selectedStatusFilter === f.id ? "active" : "";
    const count = counts[f.id] || 0;
    return `<button type="button" class="status-chip ${f.className} ${active}" data-status="${f.id}">
      <span>${t(f.key)}</span><strong>${count}</strong>
    </button>`;
  }).join("");
}

function getAvailableTypes() {
  return [...new Set(getDisplayDevices().map((d) => d.product || "").filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function renderTypeFilters() {
  const types = getAvailableTypes();
  els.typeFilters.innerHTML = types
    .map((type) => {
      const active = selectedTypes.has(type) ? "active" : "";
      const count = getDisplayDevices().filter((d) => (d.product || "") === type).length;
      return `<button type="button" class="type-chip ${active}" data-type="${type}">
        <span>${type}</span><strong>${count}</strong>
      </button>`;
    })
    .join("");
}

function render() {
  const filteredDevices = getFilteredDevices();
  const online = filteredDevices.filter((d) => d.status === "online").length;
  const offline = filteredDevices.filter((d) => d.status === "offline").length;
  const inCall = filteredDevices.filter((d) => d.inCall).length;
  const activeFaults = filteredDevices.reduce((n, d) => n + d.faults.length, 0);

  els.stats.innerHTML = `
    <div class="stat"><div>${t("stats.total")}</div><div class="stat-value">${filteredDevices.length}</div></div>
    <div class="stat"><div>${t("stats.online")}</div><div class="stat-value">${online}</div></div>
    <div class="stat"><div>${t("stats.offline")}</div><div class="stat-value">${offline}</div></div>
    <div class="stat"><div>${t("stats.inCall")}</div><div class="stat-value">${inCall}</div></div>
    <div class="stat"><div>${t("stats.faults")}</div><div class="stat-value">${activeFaults}</div></div>
  `;

  const orderedDevices = [...filteredDevices].sort((a, b) => Number(b.inCall) - Number(a.inCall));
  els.devices.innerHTML = orderedDevices
    .map((d) => {
      const badge = getDeviceBadge(d);
      const associatedNavigators = getAssociatedNavigators(d);
      const navigatorDotClass =
        associatedNavigators[0]?.status === "online"
          ? "online"
          : associatedNavigators[0]?.status === "offline"
            ? "offline"
            : "unknown";
      const signalBadges = isMeetingRoomDevice(d)
        ? [
            d.booked ? `<span class="state-pill booked">${t("devices.booked")}</span>` : "",
            d.status === "offline"
              ? `<span class="state-pill unknown">${t("devices.unknownAvailability")}</span>`
              : d.used === true
                ? `<span class="state-pill used">${t("devices.used")}</span>`
                : d.used === false && !d.booked
                  ? `<span class="state-pill available">${t("devices.available")}</span>`
                  : ""
          ]
            .filter(Boolean)
            .join("")
        : "";
      const meetingMeta = isMeetingRoomDevice(d)
        ? `
          <div class="device-meeting">
            <div class="device-meeting-row">
              <span class="device-meeting-label">${t("devices.bookingStatus")}</span>
              <strong>${getBookingStatus(d)}</strong>
            </div>
            <div class="device-meeting-row">
              <span class="device-meeting-label">${t("devices.nextMeeting")}</span>
              <strong>${getNextMeetingLabel(d)}</strong>
            </div>
            ${
              d.nextMeeting?.title
                ? `<div class="device-meeting-title">${d.nextMeeting.title}</div>`
                : ""
            }
          </div>
        `
        : "";
      const qosAgeSec = secondsSince(d.qos?.updatedAt);
      const qosLive = d.inCall && d.qos;
      const qos = qosLive
        ? `
          <div class="qos-live">
            <div class="qos-live-head">${t("devices.qos")} LIVE${qosAgeSec !== null ? ` · ${qosAgeSec}s` : ""}</div>
            <div class="qos-grid">
              <div class="qos-item ${metricLevel("packetLossPct", d.qos.packetLossPct)}"><span>PL</span><strong>${d.qos.packetLossPct ?? "-" }%</strong></div>
              <div class="qos-item ${metricLevel("jitterMs", d.qos.jitterMs)}"><span>Jitter</span><strong>${d.qos.jitterMs ?? "-" }ms</strong></div>
              <div class="qos-item ${metricLevel("latencyMs", d.qos.latencyMs)}"><span>Delay</span><strong>${d.qos.latencyMs ?? "-" }ms</strong></div>
              <div class="qos-item"><span>MOS</span><strong>${d.qos.mos ?? "-" }</strong></div>
              <div class="qos-item"><span>${t("devices.bandwidth")}</span><strong>${formatKbps(d.qos.bandwidthKbps)}</strong></div>
              <div class="qos-item"><span>RX / TX</span><strong>${formatKbps(d.qos.rxBandwidthKbps)} / ${formatKbps(d.qos.txBandwidthKbps)}</strong></div>
            </div>
          </div>
        `
        : d.inCall
          ? `<div class="qos-idle">${t("devices.qosPending")}</div>`
          : "";
      const tagBadges = (d.tags || [])
        .map((tag) => `<span class="device-tag">${tag}</span>`)
        .join("");
      const faults = d.faults
        .filter((f) => shouldShowFault(d, f))
        .slice(0, 3)
        .map((f) => `<div class="fault ${faultClass(f)}">${f.code}: ${f.message}</div>`)
        .join("");
      const possibleCrash = d.possibleCrash || (d.status === "offline" && d.used);
      const possibleCrashBox = possibleCrash
        ? `<div class="possible-crash-box">possible crash</div>`
        : "";

      return `
      <div class="device">
        <div class="device-top">
          <div>
            <strong>${d.name}</strong>
            <div>${d.product || ""}</div>
            ${
              associatedNavigators.length > 0
                ? `<div class="device-associated-label"><span class="device-status-dot ${navigatorDotClass}"></span>${t("devices.associatedNavigator")}</div>`
                : ""
            }
          </div>
          <div class="device-status-stack">
            <span class="badge ${badge.className}">${badge.label}</span>
            ${signalBadges ? `<div class="device-signal-pills status-inline">${signalBadges}</div>` : ""}
          </div>
        </div>
        <div>${t("devices.since")} ${minutesSince(d.statusSince)} ${t("devices.minutes")}</div>
        ${meetingMeta}
        ${possibleCrashBox}
        ${qos}
        <div class="device-tags">${tagBadges}</div>
        ${faults}
      </div>
    `;
    })
    .join("");
  if (orderedDevices.length === 0 && (selectedTags.size > 0 || selectedTypes.size > 0 || selectedStatusFilter !== "all")) {
    els.devicesEmpty.innerHTML = `${t("devices.noMatch")} <button type="button" class="tag-chip" id="clear-tags-inline">${t("filters.clear")}</button>`;
    const inlineButton = document.getElementById("clear-tags-inline");
    if (inlineButton) {
      inlineButton.addEventListener("click", () => {
        selectedTags.clear();
        selectedTypes.clear();
        selectedStatusFilter = "all";
        render();
      });
    }
  } else if (orderedDevices.length === 0) {
    els.devicesEmpty.textContent = t("devices.noDevices");
  } else {
    els.devicesEmpty.textContent = "";
  }
  renderTagFilters();
  renderStatusFilters();
  renderTypeFilters();
  renderAlerts();
  renderRoute();

}

function renderAlerts() {
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const allAlertEvents = events
    .filter((event) => event.type === "fault" || event.type === "status")
    .filter((event) => isCurrentStatusEvent(event, deviceById.get(event.deviceId)))
    .filter((event) => !ignoredAlertIds.has(event.id));

  if (route === "alerts") {
    for (const event of allAlertEvents) {
      seenAlertIds.add(event.id);
    }
    localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify([...seenAlertIds]));
  }

  const visibleEvents = allAlertEvents
    .filter((event) => event.type === "fault" || event.type === "status")
    .filter((event) => {
      const device = deviceById.get(event.deviceId);
      if (!device) {
        return selectedTags.size === 0 && selectedStatusFilter === "all" && selectedTypes.size === 0;
      }
      return matchesActiveFilters(device);
    })
    .slice(0, 200);

  lastRenderedAlertIds = visibleEvents.map((event) => event.id);

  const rows = visibleEvents.map((event) => {
      const payload = event.payload || {};
      const device = deviceById.get(event.deviceId);
      const deviceLabel = device?.name || event.deviceId;
      const message = formatAlertMessage(event.type, payload);
      return `
        <div class="alert-row">
          <div class="alert-top">
            <span class="alert-type">${event.type}</span>
            <span class="alert-time">${new Date(event.at).toLocaleString()}</span>
          </div>
          <div class="alert-body"><strong>${deviceLabel}</strong><span>${message}</span></div>
          <div class="alert-actions">
            <button type="button" class="alert-ignore" data-ignore-id="${event.id}">${t("alerts.ignore")}</button>
          </div>
        </div>
      `;
    })
    .join("");

  els.alertsList.innerHTML = rows || `<div class="qos-idle">${t("alerts.empty")}</div>`;
  if (els.alertsClearAll) {
    els.alertsClearAll.disabled = lastRenderedAlertIds.length === 0;
  }
  updateAlertsBadge();
}

function formatAlertMessage(type, payload) {
  if (type === "status") {
    if (payload.status === "offline") {
      return t("alerts.deviceWentOffline");
    }
    if (payload.status === "online") {
      return t("alerts.deviceBackOnline");
    }
    return t("alerts.deviceStatusChanged");
  }
  if (type === "call") {
    return payload.inCall ? t("alerts.callStarted") : t("alerts.callEnded");
  }
  if (type === "fault") {
    const code = String(payload.code || "").toLowerCase();
    if (code.includes("device_crash") || code.includes("crash")) {
      return t("alerts.deviceCrashDetected");
    }
    const msg = payload.message || payload.code || t("alerts.issueDetected");
    return `${t("alerts.issueDetected")}: ${msg}`;
  }
  return t("alerts.eventReceived");
}

function renderRoute() {
  for (const [key, page] of Object.entries(els.pages)) {
    page.classList.toggle("active", key === route);
  }
  for (const button of els.sideLinks) {
    button.classList.toggle("active", button.dataset.route === route);
  }
  updateAlertsBadge();
}

function setRoute(nextRoute) {
  route = nextRoute === "alerts" || nextRoute === "devices" ? nextRoute : "dashboard";
  window.location.hash = `#${route}`;
  if (route === "alerts") {
    renderAlerts();
  }
  renderRoute();
}

function updateAlertsBadge() {
  const count = events
    .filter((event) => event.type === "fault" || event.type === "status")
    .filter((event) => isCurrentStatusEvent(event, devices.find((d) => d.id === event.deviceId)))
    .filter((event) => !ignoredAlertIds.has(event.id))
    .filter((event) => !seenAlertIds.has(event.id)).length;

  if (!els.alertsNewBadge) {
    return;
  }
  if (count <= 0 || route === "alerts") {
    els.alertsNewBadge.classList.add("hidden");
    return;
  }
  els.alertsNewBadge.classList.remove("hidden");
  els.alertsNewBadge.textContent = count > 99 ? "99+" : String(count);
}

function isCurrentStatusEvent(event, device) {
  if (event.type !== "status") {
    return true;
  }
  if (!device) {
    return false;
  }
  const status = String(event.payload?.status || "").toLowerCase();
  if (!status) {
    return false;
  }
  return status === String(device.status || "").toLowerCase();
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) {
      el.textContent = t(key);
    }
  });
}

async function refresh() {
  if (!token) {
    render();
    return;
  }
  try {
    const [dev, evt] = await Promise.all([api("/api/devices"), api("/api/events?limit=400")]);
    devices = dev.items || [];
    events = evt.items || [];
    render();
  } catch (error) {
    if (error.status === 401) {
      devices = [];
      events = [];
      render();
      resetAuth("auth.sessionExpired");
      return;
    }
    throw error;
  }
}

function connectWebSocket() {
  if (!token) {
    return;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === "snapshot" || data.type === "delta") {
      devices = data.payload || [];
      render();
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 1000);
  };
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const email = els.email.value;
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    els.authPanel.style.display = "none";
    showAuthError("");
    await refresh();
    connectWebSocket();
  } catch {
    resetAuth("auth.loginFailed");
  }
});

els.language.addEventListener("change", async (event) => {
  const lang = event.target.value;
  const i18n = await loadLanguage(lang);
  t = i18n.t;
  els.language.value = i18n.lang;
  applyTranslations();
  render();
});

function handleTagFilterClick(event) {
  const button = event.target.closest(".tag-chip");
  if (!button) {
    return;
  }
  const tag = button.getAttribute("data-tag");
  if (!tag) {
    return;
  }
  if (selectedTags.has(tag)) {
    selectedTags.delete(tag);
  } else {
    selectedTags.add(tag);
  }
  render();
}

els.tagFilters.addEventListener("click", handleTagFilterClick);
if (els.tagFiltersAlerts) {
  els.tagFiltersAlerts.addEventListener("click", handleTagFilterClick);
}
if (els.tagFiltersSide) {
  els.tagFiltersSide.addEventListener("click", handleTagFilterClick);
}

els.statusFilters.addEventListener("click", (event) => {
  const button = event.target.closest(".status-chip");
  if (!button) {
    return;
  }
  const statusId = button.getAttribute("data-status");
  if (!statusId) {
    return;
  }
  selectedStatusFilter = selectedStatusFilter === statusId ? "all" : statusId;
  render();
});

els.typeFilters.addEventListener("click", (event) => {
  const button = event.target.closest(".type-chip");
  if (!button) {
    return;
  }
  const type = button.getAttribute("data-type");
  if (!type) {
    return;
  }
  if (selectedTypes.has(type)) {
    selectedTypes.delete(type);
  } else {
    selectedTypes.add(type);
  }
  render();
});

els.alertsList.addEventListener("click", (event) => {
  const button = event.target.closest(".alert-ignore");
  if (!button) {
    return;
  }
  const alertId = button.getAttribute("data-ignore-id");
  if (!alertId) {
    return;
  }
  ignoredAlertIds.add(alertId);
  localStorage.setItem(IGNORED_ALERTS_KEY, JSON.stringify([...ignoredAlertIds]));
  seenAlertIds.add(alertId);
  localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify([...seenAlertIds]));
  renderAlerts();
});

if (els.alertsClearAll) {
  els.alertsClearAll.addEventListener("click", () => {
    for (const id of lastRenderedAlertIds) {
      ignoredAlertIds.add(id);
      seenAlertIds.add(id);
    }
    localStorage.setItem(IGNORED_ALERTS_KEY, JSON.stringify([...ignoredAlertIds]));
    localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify([...seenAlertIds]));
    renderAlerts();
  });
}

els.clearTags.addEventListener("click", () => {
  selectedTags.clear();
  render();
});
if (els.clearTagsAlerts) {
  els.clearTagsAlerts.addEventListener("click", () => {
    selectedTags.clear();
    render();
  });
}

for (const button of els.sideLinks) {
  button.addEventListener("click", () => {
    setRoute(button.dataset.route || "dashboard");
  });
}

async function bootstrap() {
  const i18n = await loadLanguage(detectLanguage());
  t = i18n.t;
  els.language.value = i18n.lang;
  applyTranslations();
  const hashRoute = window.location.hash.replace("#", "");
  route = hashRoute === "alerts" || hashRoute === "devices" ? hashRoute : "dashboard";
  renderRoute();

  if (token) {
    els.authPanel.style.display = "none";
    try {
      await refresh();
      connectWebSocket();
    } catch {
      resetAuth("auth.sessionExpired");
    }
  } else {
    render();
  }
}

bootstrap();
setInterval(() => {
  refresh().catch(() => undefined);
}, 10_000);
