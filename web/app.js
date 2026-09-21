const FEED_ENDPOINT = window.TIBO_RESET_WATCH_CONFIG?.feedEndpoint || "/api/feed";
const TIBO_HANDLE = "thsottiaux";
const NORMAL_INTERVAL_MS = 120_000;
const RECENT_HISTORY_MS = 3 * 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "tibo-reset-watch.web.v1";
const POST_TYPES = { all: "全部动态", post: "自己发帖", reply: "回复他人", unknown: "类型待确认" };

const refs = {
  postFilters: document.getElementById("post-filters"),
  historyRange: document.getElementById("history-range"),
  latestCards: document.getElementById("latest-cards"),
  latestReplyContext: document.getElementById("latest-reply-context"),
  latestType: document.getElementById("latest-type"),
  sourceIndicator: document.getElementById("source-indicator"),
  sourceState: document.getElementById("source-state"),
  checkNow: document.getElementById("check-now"),
  enableNotifications: document.getElementById("enable-notifications"),
  updatedMeta: document.getElementById("updated-meta"),
  sourceProvider: document.getElementById("source-provider"),
  statusLive: document.getElementById("status-live"),
  feedFreshness: document.getElementById("feed-freshness"),
  nextCheck: document.getElementById("next-check"),
  latestTime: document.getElementById("latest-time"),
  latestText: document.getElementById("latest-text"),
  latestLink: document.getElementById("latest-link"),
  latestPostKind: document.getElementById("latest-post-kind"),
  latestPanel: document.querySelector(".latest-panel"),
  recentPostCount: document.getElementById("recent-post-count"),
  recentPostsList: document.getElementById("recent-posts-list"),
  alertMode: document.getElementById("alert-mode"),
  alertCount: document.getElementById("alert-count"),
  alertsList: document.getElementById("alerts-list"),
  lastChecked: document.getElementById("last-checked"),
  errorBanner: document.getElementById("error-banner"),
  errorText: document.getElementById("error-text"),
};

const state = {
  postFilter: "all",
  historyRange: "all",
  polling: false,
  failures: 0,
  timer: null,
  countdownTimer: null,
  nextPollAt: null,
  feedFetchedAt: null,
  posts: [],
  alerts: [],
  primed: false,
  seen: new Set(),
  mode: "possibleAndConfirmed",
};

const confirmedPhrases = [
  "i've reset usage limits",
  "i have reset usage limits",
  "we've reset usage limits",
  "we have reset usage limits",
  "usage limits have been reset",
  "usage limit has been reset",
  "usage limits reset for all",
  "reset usage limits for all",
  "reset the usage limits for all",
  "limits have been reset",
];

const quotaContextPhrases = [
  "usage limit",
  "usage limits",
  "limit reset",
  "quota",
  "codex",
  "chatgpt work",
  "banked reset",
];

const futurePhrases = [
  "will reset",
  "going to reset",
  "about to reset",
  "in a few hours",
  "next hour",
  "later today",
  "tomorrow",
  "feeling like a limit reset",
  "time for a reset",
  "more manual resets",
];

const noResetPhrases = [
  "no reset",
  "not a reset",
  "isn't a reset",
  "is not a reset",
  "not about to announce a reset",
];

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function isTiboPost(post) {
  if (!post || typeof post.id !== "string" || typeof post.url !== "string") return false;

  try {
    const url = new URL(post.url);
    const allowedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
    const path = url.pathname.split("/").filter(Boolean);
    return allowedHosts.has(url.hostname.toLowerCase()) &&
      path.length >= 3 &&
      path[0].toLowerCase() === TIBO_HANDLE &&
      path[1].toLowerCase() === "status" &&
      path[2] === post.id;
  } catch {
    return false;
  }
}

function classify(post) {
  const text = String(post.text || "").toLowerCase();
  if (containsAny(text, noResetPhrases)) return null;

  const verification = post.reset_verification_status || post.reset_verification?.status;
  if (verification === "confirmed" || containsAny(text, confirmedPhrases)) {
    return { post, level: "confirmed", key: `${post.id}|confirmed` };
  }

  if (text.includes("reset") && containsAny(text, quotaContextPhrases) && containsAny(text, futurePhrases)) {
    return { post, level: "upcoming", key: `${post.id}|upcoming` };
  }

  return null;
}

function readStoredState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.postFilter = Object.hasOwn(POST_TYPES, stored.postFilter) ? stored.postFilter : "all";
    state.historyRange = stored.historyRange === "recent" ? "recent" : "all";
    state.primed = stored.primed === true;
    state.mode = stored.mode === "confirmedOnly" ? "confirmedOnly" : "possibleAndConfirmed";
    state.seen = new Set(Array.isArray(stored.seen) ? stored.seen : []);
  } catch {
    state.primed = false;
    state.mode = "possibleAndConfirmed";
    state.seen = new Set();
  }
  refs.alertMode.value = state.mode;
  refs.historyRange.value = state.historyRange;
}

function saveStoredState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      primed: state.primed,
      postFilter: state.postFilter,
      historyRange: state.historyRange,
      mode: state.mode,
      seen: [...state.seen].slice(-200),
    }));
  } catch {
    // Private browsing or a blocked storage policy should not stop polling.
  }
}

function compactText(text, limit = 240) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function fullPostText(text) {
  return String(text || "").trim() || "（此动态没有文本内容）";
}

function formatTime(value, fallback = "等待中") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCheckedTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function formatFreshness(value) {
  if (!value) return "等待中";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "等待中";

  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1_000));
  if (seconds < 45) return "刚刚更新";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} 小时前`;
  return `${Math.round(seconds / 86_400)} 天前`;
}

function sourcePresentation(snapshot) {
  const source = String(snapshot.source || "").toLowerCase();
  if (source === "x-filtered-stream") {
    return { label: "X 实时流", cadence: "X 会实时推送新动态，页面每 2 分钟再确认一次" };
  }
  if (source === "vps-push") {
    return { label: "公开数据源", cadence: "数据通常每 15 分钟更新" };
  }
  if (source === "x-api") {
    return { label: "Codex Reset 上游", cadence: "上游约每分钟发布，页面每 2 分钟读取" };
  }
  if (source === "fx-twitter-public") {
    return { label: "X 公开时间线镜像", cadence: "页面每 2 分钟读取一次最新时间线" };
  }
  return { label: snapshot.source || "公开数据源", cadence: "页面每 2 分钟检查一次" };
}

function updateCountdown() {
  if (state.polling) {
    refs.nextCheck.textContent = "检查中";
  } else if (!state.nextPollAt) {
    refs.nextCheck.textContent = "等待中";
  } else {
    const seconds = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1_000));
    const minutes = Math.floor(seconds / 60);
    refs.nextCheck.textContent = seconds === 0
      ? "即将检查"
      : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  if (state.feedFetchedAt) refs.feedFreshness.textContent = formatFreshness(state.feedFetchedAt);
}

function setSourceState(text, status = "loading") {
  refs.sourceState.textContent = text;
  refs.sourceIndicator.dataset.state = status;
  refs.statusLive.dataset.state = status;
  refs.statusLive.lastChild.textContent = status === "ok" ? "正常运行" : status === "error" ? "连接异常" : "正在读取";
}

function setError(message = "") {
  refs.errorBanner.hidden = !message;
  if (message) refs.errorText.textContent = message;
}

function setLatestPanelState(status) {
  refs.latestPanel.dataset.state = status;
  refs.latestPanel.setAttribute("aria-busy", String(status === "loading"));
}

function retryIntervalMs(failureCount) {
  return Math.min(900_000, 60_000 * (2 ** Math.max(failureCount - 1, 0)));
}

function validateSnapshot(snapshot) {
  if (snapshot.stale) throw new Error("数据源已经过期");
  if (snapshot.source_scope?.toLowerCase() !== "timeline" ||
      snapshot.profile?.handle?.toLowerCase() !== TIBO_HANDLE) {
    throw new Error("数据源不是 @thsottiaux 本人的时间线");
  }

  const sourcePosts = Array.isArray(snapshot.tweets) ? snapshot.tweets : [];
  const posts = sourcePosts.filter(isTiboPost);
  if (sourcePosts.length > 0 && posts.length === 0) {
    throw new Error("没有找到由 Tibo 本人发布的帖子");
  }
  return posts;
}

// 新旧记录统一按来源元数据分类，缺少依据时不从正文猜测。
function postType(post) {
  const target = typeof post.replying_to === "string" ? post.replying_to.trim().replace(/^@/, "") : "";
  if (target.toLowerCase() === TIBO_HANDLE) return { type: "post", label: "自己发帖 · 续帖" };
  if (target || post.is_reply === true || post.referenced_tweets?.some((item) => item.type === "replied_to")) {
    return { type: "reply", label: target ? `回复 @${target}` : "回复 · 对象未提供" };
  }
  if (post.is_reply === false || Array.isArray(post.referenced_tweets)) return { type: "post", label: POST_TYPES.post };
  return { type: "unknown", label: POST_TYPES.unknown };
}

function matchesPostFilter(post) {
  return state.postFilter === "all" || postType(post).type === state.postFilter;
}

function createTypeBadge(post) {
  const badge = document.createElement("span");
  const kind = postType(post);
  badge.className = "timeline-kind";
  badge.dataset.type = kind.type;
  badge.textContent = kind.label;
  return badge;
}

function createReplyContext(post) {
  const kind = postType(post);
  if (kind.type !== "reply") return null;

  const context = post.reply_context;
  const root = document.createElement("aside");
  root.className = "reply-context";
  root.dataset.state = context?.text ? "ready" : "unavailable";

  const heading = document.createElement("div");
  heading.className = "reply-context-heading";
  const label = document.createElement("span");
  label.textContent = "被回复的原文";
  const author = document.createElement("strong");
  const handle = String(context?.author_handle || post.replying_to || "").replace(/^@/, "");
  author.textContent = handle ? `@${handle}` : "原作者";
  heading.append(label, author);

  const text = document.createElement("blockquote");
  text.textContent = context?.text || "原帖正文暂时无法读取，可直接查看被回复原帖。";
  root.append(heading, text);

  const tweetId = String(post.in_reply_to_tweet_id || "");
  const fallbackUrl = /^\d+$/.test(tweetId) ? `https://x.com/i/status/${tweetId}` : "";
  const url = context?.url || fallbackUrl;
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看被回复原帖 ↗";
    root.append(link);
  }
  return root;
}

async function enrichReplyContexts(posts) {
  await Promise.all(posts.map(async (post) => {
    const tweetId = String(post.in_reply_to_tweet_id || "");
    if (!/^\d+$/.test(tweetId) || post.reply_context) return;
    try {
      const response = await fetch(`/api/reply-context?id=${encodeURIComponent(tweetId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      if (result.reply_context?.text) post.reply_context = result.reply_context;
    } catch {
      // 主 feed 已可用时，回复上下文补全失败不应阻断整页展示。
    }
  }));
}

function renderPostFilters() {
  refs.postFilters.replaceChildren();
  for (const [type, label] of Object.entries(POST_TYPES)) {
    const count = state.posts.filter((post) => type === "all" || postType(post).type === type).length;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.filter = type;
    button.className = "filter-button";
    button.setAttribute("aria-pressed", String(state.postFilter === type));
    button.setAttribute("aria-controls", "latest-text recent-posts-list alerts-list");
    button.textContent = `${label} · ${count}`;
    refs.postFilters.append(button);
  }
}

function updateLatest(posts) {
  const post = posts.find(matchesPostFilter);
  refs.latestCards.replaceChildren();
  refs.latestReplyContext.replaceChildren();
  if (!post) {
    refs.latestType.textContent = POST_TYPES[state.postFilter];
    refs.latestTime.textContent = "等待中";
    refs.latestText.textContent = "当前分类暂无动态，可切换其他分类。";
    refs.latestPostKind.textContent = "还没有新动态";
    refs.latestPostKind.dataset.level = "other";
    refs.latestLink.hidden = true;
    setLatestPanelState("empty");
    return;
  }

  refs.latestCards.append(window.TiboPostCards.create(post, postType(post)));
  const signal = classify(post);
  const kind = postType(post);
  refs.latestType.textContent = kind.label;
  refs.latestType.dataset.type = kind.type;
  refs.latestTime.textContent = formatTime(post.at);
  refs.latestText.textContent = fullPostText(post.text);
  const replyContext = createReplyContext(post);
  if (replyContext) refs.latestReplyContext.append(replyContext);
  refs.latestPostKind.textContent = signal?.level === "confirmed"
    ? "已经确认重置"
    : signal?.level === "upcoming" ? "可能重置" : "普通动态";
  refs.latestPostKind.dataset.level = signal?.level || "other";
  refs.latestLink.href = post.url;
  refs.latestLink.hidden = false;
  setLatestPanelState(signal?.level === "confirmed" ? "confirmed" : signal?.level === "upcoming" ? "possible" : "neutral");
}

function getRecentPosts(posts) {
  const cutoff = Date.now() - RECENT_HISTORY_MS;
  return posts
    .filter((post) => {
      const publishedAt = Date.parse(post.at);
      return state.historyRange === "all" || (Number.isFinite(publishedAt) && publishedAt >= cutoff);
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function createRecentPostRow(post) {
  const row = document.createElement("article");
  row.className = "timeline-row";
  const safeId = String(post.id || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  row.dataset.odId = `recent-post-${safeId || "unknown"}`;

  const meta = document.createElement("div");
  meta.className = "timeline-post-meta";
  const kind = createTypeBadge(post);
  const time = document.createElement("time");
  time.dateTime = post.at || "";
  time.textContent = formatTime(post.at);
  meta.append(kind, time);

  const text = document.createElement("p");
  text.className = "timeline-text";
  text.textContent = fullPostText(post.text);

  const link = document.createElement("a");
  link.className = "timeline-link";
  link.href = post.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "查看 X 原帖 ↗";

  const replyContext = createReplyContext(post);
  row.append(meta, text);
  if (replyContext) row.append(replyContext);
  row.append(link, window.TiboPostCards.create(post, postType(post)));
  return row;
}

function renderRecentPosts() {
  refs.recentPostsList.replaceChildren();
  const recentPosts = getRecentPosts(state.posts).filter(matchesPostFilter);
  refs.recentPostCount.textContent = `${POST_TYPES[state.postFilter]} · ${recentPosts.length} 条`;

  if (recentPosts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "当前范围暂无动态";
    const body = document.createElement("span");
    body.textContent = "可切换分类或时间范围；这里只展示数据源提供的记录。";
    empty.append(title, body);
    refs.recentPostsList.append(empty);
  } else {
    recentPosts.forEach((post) => refs.recentPostsList.append(createRecentPostRow(post)));
  }

  refs.recentPostsList.setAttribute("aria-busy", "false");
}

function updateSourceFacts(snapshot, posts) {
  const presentation = sourcePresentation(snapshot);
  state.feedFetchedAt = snapshot.fetched_at || null;
  refs.sourceProvider.textContent = presentation.label;
  refs.feedFreshness.textContent = formatFreshness(state.feedFetchedAt);
  refs.lastChecked.textContent = formatCheckedTime();
  refs.updatedMeta.textContent = posts[0]?.at
    ? `最近一条发布于 ${formatTime(posts[0].at)}，${presentation.cadence}`
    : `暂时没有动态，${presentation.cadence}`;
}

function createAlertRow(alert) {
  const row = document.createElement("article");
  row.className = `alert-row ${alert.level}`;
  const safeId = String(alert.post.id || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  row.dataset.odId = `alert-${safeId || "unknown"}-${alert.level}`;

  const head = document.createElement("div");
  head.className = "alert-head";
  const kind = document.createElement("span");
  kind.className = "alert-kind";
  kind.textContent = alert.level === "confirmed" ? "已经确认重置" : "可能重置";
  const time = document.createElement("time");
  time.dateTime = alert.post.at || "";
  time.textContent = formatTime(alert.post.at);
  head.append(kind, createTypeBadge(alert.post), time);

  const text = document.createElement("p");
  text.className = "alert-text";
  text.textContent = fullPostText(alert.post.text);

  const link = document.createElement("a");
  link.className = "alert-link";
  link.href = alert.post.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "查看 X 原帖 ↗";

  const replyContext = createReplyContext(alert.post);
  row.append(head, text);
  if (replyContext) row.append(replyContext);
  row.append(link, window.TiboPostCards.create(alert.post, postType(alert.post)));
  return row;
}

function renderAlerts() {
  refs.alertsList.replaceChildren();
  const visible = state.alerts.filter((alert) => matchesPostFilter(alert.post) &&
    (state.mode !== "confirmedOnly" || alert.level === "confirmed"));
  refs.alertCount.textContent = `${visible.length} 条 Reset 动态`;

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "还没有 Reset 动态";
    const body = document.createElement("span");
    body.textContent = state.mode === "confirmedOnly" ? "这里现在只显示已经确认的重置。" : "Tibo 提到 Reset 后，相关帖子会出现在这里。";
    empty.append(title, body);
    refs.alertsList.append(empty);
    refs.alertsList.setAttribute("aria-busy", "false");
    return;
  }

  visible.slice(0, 10).forEach((alert) => refs.alertsList.append(createAlertRow(alert)));
  refs.alertsList.setAttribute("aria-busy", "false");
}

function notificationAllowed(alert) {
  return state.mode === "possibleAndConfirmed" || alert.level === "confirmed";
}

function notifyAlert(alert) {
  if (!notificationAllowed(alert) || !("Notification" in window) || Notification.permission !== "granted") return;

  const notification = new Notification(
    alert.level === "confirmed" ? "Tibo 已确认 Codex reset" : "Tibo 可能要重置 Codex 额度",
    { body: compactText(alert.post.text), tag: `tibo-reset-${alert.key}` },
  );
  notification.onclick = () => {
    window.focus();
    window.open(alert.post.url, "_blank", "noopener,noreferrer");
  };
}

function updateNotificationButton() {
  if (!("Notification" in window)) {
    refs.enableNotifications.textContent = "浏览器不支持通知";
    refs.enableNotifications.dataset.state = "unsupported";
    refs.enableNotifications.setAttribute("aria-pressed", "false");
    refs.enableNotifications.disabled = true;
  } else if (Notification.permission === "granted") {
    refs.enableNotifications.textContent = "通知已开启";
    refs.enableNotifications.dataset.state = "granted";
    refs.enableNotifications.setAttribute("aria-pressed", "true");
  } else if (Notification.permission === "denied") {
    refs.enableNotifications.textContent = "浏览器不允许通知";
    refs.enableNotifications.dataset.state = "denied";
    refs.enableNotifications.setAttribute("aria-pressed", "false");
  } else {
    refs.enableNotifications.textContent = "开启浏览器通知";
    refs.enableNotifications.dataset.state = "default";
    refs.enableNotifications.setAttribute("aria-pressed", "false");
  }
}

async function requestNotifications() {
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  updateNotificationButton();
}

function scheduleNext(delayMs) {
  window.clearTimeout(state.timer);
  state.nextPollAt = Date.now() + delayMs;
  updateCountdown();
  state.timer = window.setTimeout(() => poll(), delayMs);
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  refs.checkNow.disabled = true;
  refs.checkNow.textContent = "检查中…";
  refs.alertsList.setAttribute("aria-busy", "true");
  setLatestPanelState("loading");
  state.nextPollAt = null;
  updateCountdown();
  setSourceState("正在读取 Tibo 的动态", "loading");

  try {
    const response = await fetch(FEED_ENDPOINT, { cache: "no-store" });
    if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`);
    const snapshot = await response.json();
    const posts = validateSnapshot(snapshot).sort((left, right) => String(right.at).localeCompare(String(left.at)));
    await enrichReplyContexts(posts);
    const alerts = posts.map(classify).filter(Boolean);
    state.posts = posts;
    state.alerts = alerts;
    state.failures = 0;

    renderPostFilters();
    updateLatest(posts);
    renderRecentPosts();
    updateSourceFacts(snapshot, posts);
    renderAlerts();
    setSourceState(`已读取 ${posts.length} 条 Tibo 动态`, "ok");
    setError();

    if (!state.primed) {
      alerts.forEach((alert) => state.seen.add(alert.key));
      state.primed = true;
      saveStoredState();
    } else {
      const unseen = alerts.filter((alert) => !state.seen.has(alert.key));
      unseen.forEach((alert) => {
        state.seen.add(alert.key);
        notifyAlert(alert);
      });
      if (unseen.length > 0) saveStoredState();
    }

    scheduleNext(NORMAL_INTERVAL_MS);
  } catch (error) {
    state.failures += 1;
    const delay = retryIntervalMs(state.failures);
    const minutes = Math.round(delay / 60_000);
    refs.lastChecked.textContent = formatCheckedTime();
    refs.feedFreshness.textContent = "读取失败";
    refs.alertsList.setAttribute("aria-busy", "false");
    refs.recentPostsList.setAttribute("aria-busy", "false");
    setLatestPanelState("error");
    setSourceState("暂时无法连接", "error");
    setError(`${error.message || "读取时出了点问题"}。系统将在 ${minutes} 分钟后重试。`);
    scheduleNext(delay);
  } finally {
    state.polling = false;
    refs.checkNow.disabled = false;
    refs.checkNow.textContent = "立即检查";
  }
}

function bind() {
  readStoredState();
  updateNotificationButton();
  renderPostFilters();
  refs.postFilters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    state.postFilter = button.dataset.filter;
    saveStoredState();
    renderPostFilters();
    refs.postFilters.querySelector(`[data-filter="${state.postFilter}"]`).focus();
    updateLatest(state.posts);
    renderRecentPosts();
    renderAlerts();
  });
  refs.historyRange.addEventListener("change", () => {
    state.historyRange = refs.historyRange.value;
    saveStoredState();
    renderRecentPosts();
  });
  state.countdownTimer = window.setInterval(updateCountdown, 1_000);
  refs.checkNow.addEventListener("click", () => poll());
  refs.enableNotifications.addEventListener("click", requestNotifications);
  refs.alertMode.addEventListener("change", () => {
    state.mode = refs.alertMode.value === "confirmedOnly" ? "confirmedOnly" : "possibleAndConfirmed";
    saveStoredState();
    renderAlerts();
  });
  poll();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.addEventListener("pagehide", () => window.clearInterval(state.countdownTimer));
  window.requestAnimationFrame(() => { document.body.dataset.ready = "true"; });
}

bind();
