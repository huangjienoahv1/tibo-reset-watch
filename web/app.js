const FEED_ENDPOINT = window.TIBO_RESET_WATCH_CONFIG?.feedEndpoint || "/api/feed";
const TIBO_HANDLE = "thsottiaux";
const NORMAL_INTERVAL_MS = 120_000;
const REPLY_CONTEXT_WORKERS = 3;
const REPLY_CONTEXT_TIMEOUT_MS = 12_000;
const RECENT_HISTORY_MS = 3 * 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "tibo-reset-watch.web.v1";
const POST_TYPES = { all: "全部动态", post: "自己发帖", reply: "回复他人", subscription: "订阅信号", unknown: "类型待确认" };
const SUBSCRIPTION_SOURCE = "rss-bz-telegram";
const SUBSCRIPTION_LABEL = "AI情报局订阅 · 第三方判定";
const CALENDAR_STATUS = { confirmed: "已确认", reported: "待核实", unknown: "无记录" };
const CALENDAR_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const CALENDAR_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" });

const refs = {
  postFilters: document.getElementById("post-filters"),
  historyRange: document.getElementById("history-range"),
  latestCards: document.getElementById("latest-cards"),
  latestAuthorName: document.getElementById("latest-author-name") || document.querySelector(".author-lockup strong"),
  latestAuthorHandle: document.getElementById("latest-author-handle") || document.querySelector(".author-lockup small"),
  latestAuthorAvatar: document.getElementById("latest-author-avatar") || document.querySelector(".author-avatar"),
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
  calendarRange: document.getElementById("calendar-range"),
  calendarSummary: document.getElementById("calendar-summary"),
  calendarGrid: document.getElementById("calendar-grid"),
  calendarNote: document.getElementById("calendar-note"),
  calendarDetails: document.getElementById("calendar-details"),
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
  subscriptionPrimed: false,
  aggregationPrimed: false,
  calendar: null,
  calendarDate: null,
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
  if (post.visibility_only || post.entry_kind === "subscription") return null;
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

function validSubscriptionSignal(signal) {
  return signal?.source === SUBSCRIPTION_SOURCE && isTiboPost(signal) &&
    ["upcoming", "confirmed"].includes(signal.status) &&
    typeof signal.summary === "string" && signal.summary.trim() &&
    /^https:\/\/t\.me\/ai_pulse_zh\/\d+$/.test(signal.source_url) &&
    Number.isFinite(Date.parse(signal.published_at));
}

function resetAlerts(snapshot, posts) {
  const alerts = new Map(posts.map(classify).filter(Boolean).map((alert) => [alert.post.id, alert]));
  const originals = new Map(posts.filter((post) => post.entry_kind !== "subscription").map((post) => [post.id, post]));
  for (const signal of Array.isArray(snapshot.reset_signals) ? snapshot.reset_signals : []) {
    if (!validSubscriptionSignal(signal)) continue;
    const existing = alerts.get(signal.id);
    if (existing) { existing.subscription = signal; continue; }
    const original = originals.get(signal.id);
    // 订阅摘要保留独立身份，没有原文时不生成原文分享卡片。
    alerts.set(signal.id, {
      post: original || { id: signal.id, url: signal.url, text: signal.summary, at: signal.published_at,
        entry_kind: "subscription", subscription: signal },
      subscription: signal, thirdParty: true, hasOriginal: Boolean(original),
      level: "upcoming", key: `${signal.id}|upcoming`,
    });
  }
  return [...alerts.values()].sort((a, b) => Date.parse(b.post.at) - Date.parse(a.post.at));
}

function readStoredState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.postFilter = Object.hasOwn(POST_TYPES, stored.postFilter) ? stored.postFilter : "all";
    state.historyRange = stored.historyRange === "recent" ? "recent" : "all";
    state.primed = stored.primed === true;
    state.subscriptionPrimed = stored.subscriptionPrimed === true;
    state.aggregationPrimed = stored.aggregationPrimed === true;
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
      subscriptionPrimed: state.subscriptionPrimed,
      aggregationPrimed: state.aggregationPrimed,
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
  if (source === "combined-public") {
    const count = snapshot.timeline_sources?.filter((item) => item.status === "ok").length || 0;
    return { label: count ? `综合来源（${count} 个时间线来源 + 订阅）`
      : snapshot.timeline_status === "cached" ? "综合来源（保留动态 + 订阅）" : "综合来源（订阅动态）",
      cadence: "页面每 2 分钟综合读取，来源失败时保留已取得的记录" };
  }
  if (source === SUBSCRIPTION_SOURCE) {
    return { label: "AI情报局订阅（时间线暂不可用）", cadence: "仅订阅信号，页面每 2 分钟检查一次" };
  }
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
  refs.statusLive.lastChild.textContent = status === "ok" ? "正常运行" : status === "warning" ? "部分来源不可用" : status === "error" ? "连接异常" : "正在读取";
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
  const subscriptionOnly = snapshot.source_scope === "reset-signals" &&
    [SUBSCRIPTION_SOURCE, "combined-public"].includes(snapshot.source) && Array.isArray(snapshot.reset_signals) &&
    snapshot.reset_signals.some(validSubscriptionSignal);
  const historyOnly = snapshot.source_scope === "reset-history" && snapshot.source === "combined-public" &&
    Array.isArray(snapshot.reset_calendar?.days);
  if ((!subscriptionOnly && !historyOnly && snapshot.source_scope?.toLowerCase() !== "timeline") ||
      snapshot.profile?.handle?.toLowerCase() !== TIBO_HANDLE) {
    throw new Error("数据源不是 @thsottiaux 本人的时间线");
  }
  const sourcePosts = Array.isArray(snapshot.tweets) ? snapshot.tweets : [];
  const posts = sourcePosts.filter(isTiboPost);
  if (sourcePosts.length > 0 && posts.length === 0) {
    throw new Error("没有找到由 Tibo 本人发布的帖子");
  }
  // 订阅进入同一个展示列表；同 ID 已有原文时只保留原文并附加订阅依据。
  const entries = new Map(posts.map((post) => [post.id, { ...post, entry_kind: "tibo" }]));
  for (const signal of Array.isArray(snapshot.reset_signals) ? snapshot.reset_signals : []) {
    if (!validSubscriptionSignal(signal)) continue;
    const original = entries.get(signal.id);
    if (original) original.subscription = signal;
    else entries.set(signal.id, { id: signal.id, url: signal.url, text: signal.summary,
      at: signal.published_at, entry_kind: "subscription", subscription: signal });
  }
  return [...entries.values()];
}

// 新旧记录统一按来源元数据分类，缺少依据时不从正文猜测。
function postType(post) {
  if (post.entry_kind === "subscription") return { type: "subscription", label: "订阅信号 · 第三方摘要" };
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

function createSubscriptionContext(signal, includeSummary) {
  if (!validSubscriptionSignal(signal)) return null;
  const source = document.createElement("aside");
  source.className = "reply-context";
  const sourceLink = document.createElement("a");
  sourceLink.href = signal.source_url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.textContent = SUBSCRIPTION_LABEL + " ↗";
  source.append(sourceLink);
  if (includeSummary) {
    const summary = document.createElement("p");
    summary.textContent = signal.summary;
    source.append(summary);
  }
  return source;
}

async function enrichReplyContexts(posts) {
  const queue = posts.filter((post) => /^\d+$/.test(String(post.in_reply_to_tweet_id || "")) && !post.reply_context);
  await Promise.all(Array.from({ length: Math.min(REPLY_CONTEXT_WORKERS, queue.length) }, async () => {
    while (queue.length && state.posts === posts) {
      const post = queue.shift();
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), REPLY_CONTEXT_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/reply-context?id=${encodeURIComponent(post.in_reply_to_tweet_id)}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) continue;
        const result = await response.json();
        if (result.reply_context?.text) post.reply_context = result.reply_context;
      } catch {
        // 原文继续展示，未取得的上下文保留明确的不可用提示。
      } finally { window.clearTimeout(timer); }
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

  const subscriptionEntry = post.entry_kind === "subscription";
  refs.latestAuthorName.textContent = subscriptionEntry ? "AI情报局" : "Tibo";
  refs.latestAuthorHandle.textContent = subscriptionEntry ? "订阅消息 · 非 Tibo 原文" : "@thsottiaux";
  refs.latestAuthorAvatar.textContent = subscriptionEntry ? "订" : "T";
  if (!subscriptionEntry) refs.latestCards.append(window.TiboPostCards.create(post, postType(post)));
  const directSignal = classify(post);
  const signal = directSignal || (post.subscription ? { level: "upcoming" } : null);
  const kind = postType(post);
  refs.latestType.textContent = kind.label;
  refs.latestType.dataset.type = kind.type;
  refs.latestTime.textContent = (subscriptionEntry ? "订阅发布于 " : "") + formatTime(post.at);
  refs.latestText.textContent = fullPostText(post.text);
  const replyContext = createReplyContext(post);
  if (replyContext) refs.latestReplyContext.append(replyContext);
  const subscriptionContext = createSubscriptionContext(post.subscription, !subscriptionEntry);
  if (subscriptionContext) refs.latestReplyContext.append(subscriptionContext);
  refs.latestPostKind.textContent = !directSignal && post.subscription
    ? (post.subscription.status === "confirmed" ? "第三方称已重置 · 待核实" : "第三方重置预告")
    : signal?.level === "confirmed"
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
  time.textContent = (post.entry_kind === "subscription" ? "订阅发布于 " : "") + formatTime(post.at);
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
  const contexts = document.createElement("div");
  contexts.className = "post-contexts";
  const subscriptionContext = createSubscriptionContext(post.subscription, post.entry_kind !== "subscription");
  if (subscriptionContext) contexts.append(subscriptionContext);
  if (replyContext) contexts.append(replyContext);
  if (contexts.childElementCount) row.append(contexts);
  row.append(link);
  if (post.entry_kind !== "subscription") row.append(window.TiboPostCards.create(post, postType(post)));
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
  state.feedFetchedAt = (snapshot.timeline_status === "cached" ? snapshot.timeline_last_success_at : snapshot.fetched_at) || null;
  refs.sourceProvider.textContent = presentation.label +
    (snapshot.source !== "combined-public" && snapshot.source_scope === "timeline" && snapshot.signal_source?.status === "ok" ? " + AI情报局订阅" : "");
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
  kind.textContent = alert.thirdParty
    ? (alert.subscription.status === "confirmed" ? "第三方称已重置 · 待核实" : "第三方重置预告")
    : alert.level === "confirmed" ? "已经确认重置" : "可能重置";
  const time = document.createElement("time");
  time.dateTime = alert.post.at || "";
  time.textContent = (alert.thirdParty && !alert.hasOriginal ? "订阅发布于 " : "") + formatTime(alert.post.at);
  head.append(kind);
  if (!alert.thirdParty || alert.hasOriginal) head.append(createTypeBadge(alert.post));
  head.append(time);

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
  const contexts = document.createElement("div");
  contexts.className = "post-contexts";
  const subscriptionContext = createSubscriptionContext(alert.subscription, !alert.thirdParty || alert.hasOriginal);
  if (subscriptionContext) contexts.append(subscriptionContext);
  if (replyContext) contexts.append(replyContext);
  if (contexts.childElementCount) row.append(contexts);
  row.append(link);
  if (!alert.thirdParty || alert.hasOriginal) row.append(window.TiboPostCards.create(alert.post, postType(alert.post)));
  return row;
}

function selectCalendarDate(date) {
  const day = state.calendar?.days.find((item) => item.date === date);
  if (!day || !refs.calendarDetails) return;
  state.calendarDate = date;
  refs.calendarGrid.querySelectorAll("button[data-date]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.date === date));
  });
  refs.calendarDetails.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `${date} · ${CALENDAR_STATUS[day.status] || CALENDAR_STATUS.unknown}`;
  refs.calendarDetails.append(heading);
  const records = Array.isArray(day.records) ? day.records : [];
  if (!records.length) {
    const empty = document.createElement("p");
    empty.textContent = "当天没有取得可核实记录，不能据此判定是否重置。";
    refs.calendarDetails.append(empty);
    return;
  }
  for (const record of records) {
    if (!isTiboPost(record)) continue;
    const item = document.createElement("article");
    item.className = "calendar-record";
    const label = document.createElement("p");
    label.className = "calendar-record-label";
    label.textContent = (record.level === "confirmed" ? "Tibo 原文确认" : "第三方已完成报告 · 待核实") +
      ` · ${CALENDAR_TIME_FORMAT.format(new Date(record.at))}`;
    const text = document.createElement("p");
    text.textContent = record.text;
    const link = document.createElement("a");
    link.href = record.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看对应 X 原帖 ↗";
    item.append(label, text, link);
    if (["https://codex-reset.com/", "https://token.jacobai.app/"].includes(record.source_url) || /^https:\/\/t\.me\/ai_pulse_zh\/\d+$/.test(record.source_url)) {
      const source = document.createElement("a");
      source.href = record.source_url;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = record.source === "rss-bz-telegram" ? "AI情报局订阅来源 ↗" : "第三方归档来源 ↗";
      item.append(source);
    }
    refs.calendarDetails.append(item);
  }
}

function renderResetCalendar(calendar) {
  if (!refs.calendarGrid || !Array.isArray(calendar?.days) || !calendar.days.length) return;
  state.calendar = calendar;
  refs.calendarRange.textContent = `${calendar.start} — ${calendar.end} · 北京时间`;
  refs.calendarSummary.textContent = `已确认 ${calendar.confirmed_days} 天 · 仅第三方报告 ${calendar.reported_days} 天`;
  refs.calendarNote.textContent = calendar.note;
  refs.calendarGrid.replaceChildren();
  for (const label of CALENDAR_WEEKDAYS) {
    const weekday = document.createElement("span");
    weekday.className = "calendar-weekday";
    weekday.textContent = label;
    refs.calendarGrid.append(weekday);
  }
  const leading = (new Date(`${calendar.start}T00:00:00Z`).getUTCDay() + 6) % CALENDAR_WEEKDAYS.length;
  for (let index = 0; index < leading; index += 1) {
    const blank = document.createElement("span");
    blank.setAttribute("aria-hidden", "true");
    refs.calendarGrid.append(blank);
  }
  for (const day of calendar.days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    button.dataset.date = day.date;
    button.dataset.status = day.status;
    button.setAttribute("aria-label", `${day.date}，${CALENDAR_STATUS[day.status] || CALENDAR_STATUS.unknown}`);
    const date = document.createElement("span");
    date.textContent = day.date.slice(5).replace("-", "/");
    const status = document.createElement("small");
    status.textContent = CALENDAR_STATUS[day.status] || CALENDAR_STATUS.unknown;
    button.append(date, status);
    refs.calendarGrid.append(button);
  }
  const selected = calendar.days.some((day) => day.date === state.calendarDate) ? state.calendarDate
    : [...calendar.days].reverse().find((day) => day.status !== "unknown")?.date || calendar.end;
  selectCalendarDate(selected);
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
    alert.thirdParty ? "AI情报局：Codex 重置信号（待核实）"
      : alert.level === "confirmed" ? "Tibo 已确认 Codex reset" : "Tibo 可能要重置 Codex 额度",
    { body: compactText(alert.subscription?.summary || alert.post.text), tag: `tibo-reset-${alert.key}` },
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
    const posts = validateSnapshot(snapshot).sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    const alerts = resetAlerts(snapshot, posts);
    state.posts = posts;
    state.alerts = alerts;
    state.failures = 0;

    renderPostFilters();
    updateLatest(posts);
    renderRecentPosts();
    updateSourceFacts(snapshot, posts);
    renderAlerts();
    renderResetCalendar(snapshot.reset_calendar);
    const warning = Array.isArray(snapshot.source_warnings) && snapshot.source_warnings.length > 0;
    setSourceState(`已综合 ${posts.length} 条动态，含 ${snapshot.reset_signals?.length || 0} 条订阅依据`, warning ? "warning" : "ok");
    setError(Array.isArray(snapshot.source_warnings) ? snapshot.source_warnings.join(" ") : "");

    enrichReplyContexts(posts).then(() => {
      if (state.posts !== posts) return;
      updateLatest(posts);
      renderRecentPosts();
      renderAlerts();
    }).catch(() => console.warn("reply_context_refresh_failed"));

    // 新增订阅渠道首次成功时静默建立基线，已有用户也不补发频道里的旧消息。
    if (!state.aggregationPrimed && snapshot.source === "combined-public") {
      alerts.forEach((alert) => state.seen.add(alert.key));
      state.aggregationPrimed = true;
      saveStoredState();
    }
    if (!state.subscriptionPrimed && ["ok", "cached"].includes(snapshot.signal_source?.status)) {
      alerts.filter((alert) => alert.thirdParty).forEach((alert) => state.seen.add(alert.key));
      state.subscriptionPrimed = true;
      saveStoredState();
    }

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
  refs.calendarGrid?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-date]");
    if (button) selectCalendarDate(button.dataset.date);
  });
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
