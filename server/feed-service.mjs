import { archiveResetRecords, buildResetCalendar, calendarOriginal, collectResetHistory } from "./reset-calendar.mjs";

// Node 与 Pages 共用公开数据源；第三方订阅只补充信号，不充当 Tibo 原文或确认依据。
const HANDLE = "thsottiaux";
const PRIMARY_URL = "https://codex-reset.com/api/feed";
const FX_URL = "https://api.fxtwitter.com/2/profile/thsottiaux/statuses?count=50&with_replies=true";
const NITTER_ORIGIN = "https://x.noodl3.net";
const NITTER_URL = `${NITTER_ORIGIN}/${HANDLE}/with_replies/rss`;
const ARCHIVE_URL = "https://token.jacobai.app/api/feed";
const NITTER_TTL_MS = 40 * 60 * 1000; // 遵循该 RSS 发布的 40 分钟 ttl。
const CHANNEL = "ai_pulse_zh";
const CHANNEL_URL = `https://t.me/s/${CHANNEL}`;
const SIGNAL_SOURCE = "rss-bz-telegram";
const TIMEOUT_MS = 12000;
const FEED_TTL_MS = 60000;
const CHANNEL_TTL_MS = 120000;
const BROWSER_CHANNEL_TTL_MS = 300000;
const BROWSER_TIMEOUT_MS = 20000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const POST_LIMIT = 100;
const SIGNAL_LIMIT = 20;
const SUMMARY_LIMIT = 4000;
const SIGNAL_LABELS = new Map([["已排期", "upcoming"], ["已完成", "confirmed"]]);
const TIMELINE_SOURCES = ["codex-reset", "fxtwitter", "nitter-rss"];

function canonicalPostUrl(value, id, handle = HANDLE) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) &&
      url.pathname.toLowerCase() === `/${handle.toLowerCase()}/status/${id}`;
  } catch { return false; }
}

function validPost(post) {
  return post && /^\d+$/.test(post.id) && typeof post.id === "string" &&
    canonicalPostUrl(post.url, post.id) && typeof post.text === "string" &&
    post.text.trim() && Number.isFinite(Date.parse(post.at));
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || snapshot.stale || snapshot.source_scope !== "timeline" ||
      String(snapshot.profile?.handle || "").toLowerCase() !== HANDLE || !Array.isArray(snapshot.tweets)) {
    throw new Error("invalid or stale Tibo timeline");
  }
  const posts = new Map();
  // radar_context 只补原文展示，visibility_only 等字段保留，不将上下文升级为重置确认。
  for (const post of [...snapshot.tweets, ...(Array.isArray(snapshot.radar_context) ? snapshot.radar_context : [])]) {
    if (validPost(post) && !posts.has(post.id)) posts.set(post.id, { ...post, visibility_only: post.visibility_only === true });
  }
  if (!posts.size) throw new Error("timeline returned no valid Tibo posts");
  const tweets = [...posts.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, POST_LIMIT);
  return { ...snapshot, tweets, newest_post_at: tweets[0].at };
}

async function requestText(fetcher, url, accept, options = {}) {
  const response = await fetcher(url, {
    headers: { Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual", ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("response too large"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function mirrorSnapshot(fetcher) {
  const result = JSON.parse(await requestText(fetcher, FX_URL, "application/json"));
  const statuses = Array.isArray(result.results) ? result.results : [];
  const contexts = new Map(statuses.filter((post) => post?.type === "status").map((post) => [String(post.id), post]));
  const tweets = statuses.filter((post) => post?.type === "status" &&
    String(post.author?.screen_name || "").toLowerCase() === HANDLE &&
    Number.isFinite(Number(post.created_timestamp))).map((post) => {
    const replyId = String(post.replying_to?.status || "");
    const parent = contexts.get(replyId);
    const quoteContext = calendarOriginal(post.quote);
    const parentHandle = String(parent?.author?.screen_name || "");
    const replyContext = parentHandle && typeof parent?.text === "string" && parent.text.trim() &&
      canonicalPostUrl(parent.url, replyId, parentHandle) ? {
        id: replyId, text: parent.text.trim(), url: parent.url, author_handle: parentHandle,
        author_name: String(parent.author?.name || ""), source: "fxtwitter",
      } : null;
    return {
      id: String(post.id), url: post.url, text: String(post.text || ""),
      at: new Date(Number(post.created_timestamp) * 1000).toISOString(),
      is_reply: Boolean(replyId), replying_to: post.replying_to?.screen_name || null,
      in_reply_to_tweet_id: replyId || null, conversation_id: replyId || String(post.id),
      replies: Number(post.replies || 0), reposts: Number(post.reposts || 0), likes: Number(post.likes || 0),
      ...(replyContext ? { reply_context: replyContext } : {}),
      ...(quoteContext ? { quote_context: quoteContext } : {}),
    };
  });
  return normalizeSnapshot({
    version: 1, fetched_at: new Date().toISOString(), source: "fx-twitter-public",
    source_scope: "timeline", stale: false, profile: { handle: HANDLE,
      name: statuses.find((post) => String(post?.author?.screen_name || "").toLowerCase() === HANDLE)?.author?.name || "Tibo" }, tweets,
  });
}

function plainText(html) {
  const entities = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }).trim();
}

function rssTimeline(xml) {
  // 只支持固定实例的 RSS 2.0 结构，不处理外部实体或通用 XML。
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml) || !/<\/rss>\s*$/i.test(xml)) throw new Error("invalid Nitter RSS");
  const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "";
  const channel = xml.split(/<item\b/i)[0];
  if (plainText(tag(channel, "link")) !== `${NITTER_ORIGIN}/${HANDLE}`) throw new Error("invalid Nitter account");
  const tweets = [];
  for (const [, block] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (plainText(tag(block, "dc:creator")).toLowerCase() !== `@${HANDLE}`) continue;
    const id = plainText(tag(block, "guid"));
    const link = plainText(tag(block, "link"));
    if (!/^\d+$/.test(id) || link !== `${NITTER_ORIGIN}/${HANDLE}/status/${id}#m`) continue;
    const title = plainText(tag(block, "title"));
    if (/^RT by @/i.test(title)) continue;
    const description = tag(block, "description").replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
    // 引用、媒体和页脚不混入作者原文；原文必须存在完整首段。
    const body = description.match(/^\s*<p>([\s\S]*?)<\/p>/i)?.[1];
    if (!body) continue;
    const replyHandle = title.match(/^R to @([A-Za-z0-9_]+):/i)?.[1];
    const post = { id, url: `https://x.com/${HANDLE}/status/${id}`, text: plainText(body),
      at: plainText(tag(block, "pubDate")), is_reply: Boolean(replyHandle), replying_to: replyHandle || null };
    if (validPost(post)) tweets.push({ ...post, at: new Date(post.at).toISOString() });
  }
  return normalizeSnapshot({ source_scope: "timeline", profile: { handle: HANDLE }, tweets });
}

function archiveReports(text) {
  const value = JSON.parse(text);
  if (value.version !== 1 || value.degraded === true || !Array.isArray(value.events) ||
      !Number.isFinite(Date.parse(value.sourceGeneratedAt))) throw new Error("invalid TokenReset archive");
  const records = value.events.flatMap((event) => {
    const id = String(event?.url || "").match(/\/status\/(\d+)$/)?.[1];
    if (!id || !canonicalPostUrl(event.url, id) || event.kind !== "regular" ||
        !["reported", "observed"].includes(event.evidence) ||
        event.id !== (event.evidence === "observed" ? `observed-${id}` : id) ||
        typeof event.text !== "string" || !event.text.trim() || !Number.isFinite(Date.parse(event.at))) return [];
    return [{ id, url: event.url, at: event.at, text: event.text, level: "reported",
      source: "tokenreset-archive", source_url: "https://token.jacobai.app/" }];
  });
  return { records, source_generated_at: value.sourceGeneratedAt };
}

function channelSignals(html) {
  // 仅解析固定公开频道的消息边界和正文，页面结构失配必须报错，不能当作没有新消息。
  const blocks = [...html.matchAll(/\bdata-post=["'](ai_pulse_zh\/(\d+))["']([\s\S]*?)(?=\bdata-post=["']|$)/g)];
  if (!blocks.length) throw new Error("Telegram preview structure changed or unavailable");
  const signals = new Map();
  let textBlocks = 0;
  let rejected = 0;
  for (const [, message, , block] of blocks) {
    const body = block.match(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!body) continue;
    textBlocks += 1;
    const text = plainText(body);
    const title = text.split("\n")[0].trim();
    const status = SIGNAL_LABELS.get(title.match(/Codex\s*重置(已排期|已完成)/)?.[1]);
    if (!status) continue;
    const ids = new Set();
    for (const [, href] of body.matchAll(/\bhref=["']([^"']+)["']/gi)) {
      const id = href.match(/\/status\/(\d+)(?:[?#]|$)/)?.[1];
      if (id && canonicalPostUrl(plainText(href), id)) ids.add(id);
    }
    const publishedAt = block.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1];
    if (ids.size !== 1 || !Number.isFinite(Date.parse(publishedAt)) || text.length > SUMMARY_LIMIT) {
      rejected += 1;
      continue;
    }
    const id = [...ids][0];
    const signal = {
      id, url: `https://x.com/${HANDLE}/status/${id}`, status, title,
      summary: text.replace(/\n*重置追踪页\s*\|\s*查看原推[\s\S]*$/, "").trim(),
      published_at: new Date(publishedAt).toISOString(), source: SIGNAL_SOURCE,
      source_url: `https://t.me/${message}`,
    };
    const previous = signals.get(id);
    if (!previous || signal.published_at > previous.published_at) signals.set(id, signal);
  }
  if (!textBlocks) throw new Error("Telegram message text unavailable");
  return { signals: [...signals.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, SIGNAL_LIMIT), rejected };
}

function validSignal(signal) {
  return signal?.source === SIGNAL_SOURCE && typeof signal.id === "string" && /^\d+$/.test(signal.id) &&
    canonicalPostUrl(signal.url, signal.id) && ["upcoming", "confirmed"].includes(signal.status) &&
    typeof signal.summary === "string" && signal.summary.trim() && signal.summary.length <= SUMMARY_LIMIT &&
    /^https:\/\/t\.me\/ai_pulse_zh\/\d+$/.test(signal.source_url) && Number.isFinite(Date.parse(signal.published_at));
}

function mergePosts(snapshots) {
  const posts = new Map();
  // 低优先级在前；本次原 feed 的明确字段覆盖镜像和缓存，保留仍有用的上下文字段。
  for (const snapshot of snapshots) {
    for (const post of snapshot?.tweets || []) {
      if (validPost(post)) posts.set(post.id, { ...posts.get(post.id), ...post });
    }
  }
  return [...posts.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, POST_LIMIT);
}

function mergeSignals(previous, current) {
  const signals = new Map();
  for (const signal of [...previous, ...current]) {
    if (!validSignal(signal)) continue;
    const old = signals.get(signal.id);
    if (!old || Date.parse(signal.published_at) >= Date.parse(old.published_at)) signals.set(signal.id, signal);
  }
  return [...signals.values()].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, SIGNAL_LIMIT);
}

function combinedEntries(tweets, signals) {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const entries = tweets.map((post) => ({ ...post, entry_kind: "tibo",
    ...(byId.has(post.id) ? { subscription: byId.get(post.id) } : {}) }));
  const ids = new Set(tweets.map((post) => post.id));
  for (const signal of signals) {
    if (!ids.has(signal.id)) entries.push({ id: signal.id, url: signal.url, text: signal.summary,
      at: signal.published_at, entry_kind: "subscription", subscription: signal });
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function createFeedService({ fetcher = (...args) => fetch(...args), logger = console, browserRun = null, storage = null } = {}) {
  let cached = null;
  let pending = null;
  let channelCache = null;
  const sourceCache = new Map();
  let previous = { tweets: [], reset_signals: [], reset_history: [] };
  let restored = false;
  async function restore() {
    if (restored) return;
    restored = true;
    if (!storage) return;
    try {
      const saved = await storage.load();
      if (saved && Array.isArray(saved.tweets) && Array.isArray(saved.reset_signals)) {
        previous = { tweets: mergePosts([saved]), reset_signals: mergeSignals([], saved.reset_signals),
          reset_history: collectResetHistory({ previous: Array.isArray(saved.reset_history) ? saved.reset_history : [] }),
          timeline_last_success_at: saved.timeline_last_success_at, signal_last_success_at: saved.signal_last_success_at };
      }
    } catch (error) { logger.warn("feed_cache_load_failed", error.message); }
  }
  async function browserContent(url) {
    if (![PRIMARY_URL, NITTER_URL, ARCHIVE_URL, CHANNEL_URL].includes(url)) throw new Error("unsupported Browser Run feed URL");
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(browserRun.accountId)}/browser-run/content`;
    const options = {
      method: "POST", signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${browserRun.apiToken}` },
      body: JSON.stringify({ url,
        gotoOptions: { waitUntil: "domcontentloaded", timeout: BROWSER_NAVIGATION_TIMEOUT_MS },
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
      }),
    };
    let text;
    try { text = await requestText(fetcher, endpoint, "application/json", options); }
    catch (error) {
      // 208 出口偶发 TCP 连接失败；仅重试一次网络错误，两次共用同一个总超时。
      if (error.name !== "TypeError" || options.signal.aborted) throw error;
      logger.warn("feed_browser_transport_retry", new URL(url).hostname, error.cause?.code || error.message);
      text = await requestText(fetcher, endpoint, "application/json", options);
    }
    const value = JSON.parse(text);
    if (value.success !== true || typeof value.result !== "string") throw new Error("Browser Run returned no feed content");
    return value.result;
  }
  async function sourceSnapshot(url, accept, parse, ttl = 0) {
    const saved = sourceCache.get(url);
    if (saved?.expiresAt > Date.now()) {
      if (saved.error) throw saved.error;
      return saved.value;
    }
    let transport = "direct";
    try {
      let value;
      try { value = parse(await requestText(fetcher, url, accept)); }
      catch (error) {
        if (!browserRun?.accountId || !browserRun?.apiToken || url === FX_URL) throw error;
        logger.warn("feed_direct_unavailable", new URL(url).hostname, error.message);
        transport = "cloudflare-browser-run";
        const html = await browserContent(url);
        const pre = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
        if (!pre) throw new Error("Browser Run returned no feed document");
        value = parse(plainText(pre));
      }
      const result = { ...value, transport, checked_at: new Date().toISOString() };
      const cacheMs = transport === "direct" ? ttl : Math.max(ttl, BROWSER_CHANNEL_TTL_MS);
      if (cacheMs) sourceCache.set(url, { value: result, expiresAt: Date.now() + cacheMs });
      return result;
    } catch (error) {
      sourceCache.set(url, { error, expiresAt: Date.now() + (transport === "direct" ? FEED_TTL_MS : BROWSER_CHANNEL_TTL_MS) });
      throw error;
    }
  }
  async function subscription() {
    if (channelCache?.expiresAt > Date.now()) return channelCache.value;
    const checkedAt = new Date().toISOString();
    let value;
    let transport = "direct";
    try {
      let html;
      try { html = await requestText(fetcher, CHANNEL_URL, "text/html"); }
      catch (error) {
        if (!browserRun?.accountId || !browserRun?.apiToken) throw error;
        logger.warn("subscription_direct_unavailable", error.message);
        transport = "cloudflare-browser-run";
        html = await browserContent(CHANNEL_URL);
      }
      const parsed = channelSignals(html);
      value = { ...parsed, status: "ok", checked_at: checkedAt, transport };
      if (parsed.rejected) logger.warn("subscription_signals_rejected", parsed.rejected);
    } catch (error) {
      logger.warn("subscription_unavailable", error.message);
      value = { signals: [], status: "unavailable", checked_at: checkedAt, transport };
    }
    // 短期缓存失败状态防止每个请求重试；不将旧成功信号冒充为本次检查结果。
    const ttl = transport === "direct" ? CHANNEL_TTL_MS : BROWSER_CHANNEL_TTL_MS;
    channelCache = { expiresAt: Date.now() + ttl, value };
    return value;
  }
  return async function feedSnapshot() {
    if (cached?.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      await restore();
      const [primary, mirror, nitter, archive, signalResult] = await Promise.allSettled([
        sourceSnapshot(PRIMARY_URL, "application/json", (text) => normalizeSnapshot(JSON.parse(text))),
        mirrorSnapshot(fetcher), sourceSnapshot(NITTER_URL, "application/rss+xml", rssTimeline, NITTER_TTL_MS),
        sourceSnapshot(ARCHIVE_URL, "application/json", archiveReports, BROWSER_CHANNEL_TTL_MS), subscription(),
      ]);
      const results = [primary, mirror, nitter];
      const checkedAt = new Date().toISOString();
      const sources = results.map((result, index) => {
        if (result.status === "rejected") logger.warn(`${TIMELINE_SOURCES[index]}_unavailable`, result.reason?.message);
        return { source: TIMELINE_SOURCES[index], status: result.status === "fulfilled" ? "ok" : "unavailable",
          checked_at: result.status === "fulfilled" ? result.value.checked_at || checkedAt : checkedAt,
          transport: result.status === "fulfilled" ? result.value.transport || "direct" : undefined,
          posts: result.status === "fulfilled" ? result.value.tweets.length : 0 };
      });
      const timelineOk = results.some((result) => result.status === "fulfilled");
      const channel = signalResult.status === "fulfilled" ? signalResult.value : { status: "unavailable", signals: [] };
      const tweets = mergePosts([previous, nitter.status === "fulfilled" ? nitter.value : null, mirror.status === "fulfilled" ? mirror.value : null,
        primary.status === "fulfilled" ? primary.value : null]);
      const signals = mergeSignals(previous.reset_signals, channel.signals);
      const resetHistory = collectResetHistory({ posts: tweets, signals,
        archives: [...archiveResetRecords(primary.status === "fulfilled" ? primary.value.events : []),
          ...(archive.status === "fulfilled" ? archive.value.records : [])],
        previous: previous.reset_history });
      if (!tweets.length && !signals.length && !resetHistory.length) throw new Error("all feed sources unavailable or no usable posts");
      const warnings = [];
      if (archive.status === "rejected") { logger.warn("tokenreset_archive_unavailable", archive.reason?.message); warnings.push("TokenReset 历史来源暂不可用，已保留已有重置记录。"); }
      if (!timelineOk) warnings.push(tweets.length ? "时间线来源暂不可用，已保留上次成功取得的动态。"
        : signals.length ? "时间线暂不可用，当前显示订阅动态。" : "时间线暂不可用，当前显示历史重置记录。");
      else if (sources.some((source) => source.status !== "ok")) warnings.push("部分时间线来源暂不可用，已合并可用来源与保留记录。");
      if (channel.status !== "ok") warnings.push(signals.length ? "订阅来源暂不可用，已保留上次取得的信号。" : "AI情报局订阅暂不可用，当前使用时间线动态。");
      if (channel.rejected) warnings.push("部分订阅消息未通过原帖链接或格式校验，已排除。");
      const timelineLastSuccess = timelineOk ? sources.filter((source) => source.status === "ok").map((source) => source.checked_at).sort().at(-1) : previous.timeline_last_success_at;
      const signalLastSuccess = channel.status === "ok" ? channel.checked_at : previous.signal_last_success_at;
      const value = {
        version: 1, source: "combined-public", source_scope: tweets.length ? "timeline" : signals.length ? "reset-signals" : "reset-history",
        stale: false, profile: { handle: HANDLE, name: "Tibo" }, checked_at: checkedAt,
        fetched_at: [timelineLastSuccess, signalLastSuccess].filter(Boolean).sort().at(-1) || null,
        tweets, newest_post_at: tweets[0]?.at || null, reset_signals: signals,
        feed_entries: combinedEntries(tweets, signals), timeline_sources: sources,
        reset_history: resetHistory, reset_calendar: buildResetCalendar(resetHistory),
        timeline_status: timelineOk ? "ok" : tweets.length ? "cached" : "unavailable",
        timeline_last_success_at: timelineLastSuccess, signal_last_success_at: signalLastSuccess,
        archive_source: { source: "tokenreset-archive", status: archive.status === "fulfilled" ? "ok" : "unavailable",
          checked_at: archive.status === "fulfilled" ? archive.value.checked_at : checkedAt,
          transport: archive.status === "fulfilled" ? archive.value.transport : undefined,
          source_generated_at: archive.status === "fulfilled" ? archive.value.source_generated_at : undefined },
        signal_source: { source: SIGNAL_SOURCE, status: channel.status === "ok" ? "ok" : signals.length ? "cached" : "unavailable",
          checked_at: channel.checked_at, last_success_at: signalLastSuccess, transport: channel.transport },
        source_warnings: warnings,
      };
      previous = value;
      if (storage && (timelineOk || channel.status === "ok" || archive.status === "fulfilled")) {
        try { await storage.save({ tweets, reset_signals: signals, reset_history: resetHistory,
          timeline_last_success_at: timelineLastSuccess, signal_last_success_at: signalLastSuccess }); }
        catch (error) { logger.warn("feed_cache_save_failed", error.message); warnings.push("动态缓存保存失败，重启后可能无法保留本次记录。"); }
      }
      cached = { expiresAt: Date.now() + FEED_TTL_MS, value };
      return value;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
