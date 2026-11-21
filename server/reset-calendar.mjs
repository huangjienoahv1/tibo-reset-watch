// 最近 30 个北京时间自然日；统计确认日，不推断账户实际恢复时间。
const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const HISTORY_LIMIT = 300;
const MAX_TEXT_LENGTH = 24000;
const RESET_CONTEXT = /\b(?:reset|resets|usage limits?)\b/i;
const BANKED_CONTEXT = /\bbanked\b|\breset cards?\b|重置卡/i;
const NEGATIVE_CONTEXT = /\bno reset\b|\bnot a reset\b|\bhas not been reset\b|\bhave not been reset\b/i;
const SHORT_COMPLETION = /^(?:done(?: and dusted)?|all (?:done|propagated)|confirmed landed across all accounts)[.!?\s]*(?:how are we doing so far\??)?(?:\s*https?:\/\/\S+)?$/i;
const EXPLICIT_COMPLETION = [
  /\b(?:usage limits?|limits?) (?:have|has) been reset\b/i,
  /\b(?:i|we)(?:'ve| have) reset (?:the )?usage limits?\b/i,
  /\bresets? (?:has|have) been (?:processed|completed)\b/i,
  /\bresets? (?:are )?all propagated\b/i,
  /\breset\b[\s\S]{0,160}\b(?:it(?:'s| is) done|all propagated)\b/i,
];
const ARCHIVE_COMPLETION = /\b(?:landed|arrived|fully propagated|all propagated|has been processed|has been completed)\b/i;

function dayKey(at) { return new Date(Date.parse(at) + BEIJING_OFFSET_MS).toISOString().slice(0, 10); }
function validUrl(url, id) {
  return typeof id === "string" && /^\d+$/.test(id) &&
    typeof url === "string" && new RegExp(`^https://(?:www\\.)?(?:x|twitter)\\.com/thsottiaux/status/${id}(?:[?#].*)?$`, "i").test(url);
}
function validPost(post) {
  return post && validUrl(post.url, post.id) && typeof post.text === "string" &&
    post.text.trim() && post.text.length <= MAX_TEXT_LENGTH && Number.isFinite(Date.parse(post.at));
}
function windowRange(now) {
  const end = dayKey(new Date(now).toISOString());
  const lastDay = Date.parse(`${end}T00:00:00Z`);
  const firstDay = lastDay - (WINDOW_DAYS - 1) * DAY_MS;
  return { start: new Date(firstDay).toISOString().slice(0, 10), end, firstDay };
}
function resetContext(post, posts, depth = 0) {
  if (!validPost(post) || BANKED_CONTEXT.test(post.text) || NEGATIVE_CONTEXT.test(post.text) || depth > 3) return false;
  if (RESET_CONTEXT.test(post.text)) return true;
  return resetContext(post.quote_context, posts, depth + 1) ||
    resetContext(posts.get(String(post.in_reply_to_tweet_id || "")), posts, depth + 1);
}
function confirmedPost(post, posts) {
  if (!validPost(post) || BANKED_CONTEXT.test(post.text) || NEGATIVE_CONTEXT.test(post.text)) return false;
  if (post.quote_context && BANKED_CONTEXT.test(String(post.quote_context.text || ""))) return false;
  const text = post.text.replace(/[’‘]/g, "'");
  if (EXPLICIT_COMPLETION.some((pattern) => pattern.test(text))) return true;
  if ((post.reset_verification_status || post.reset_verification?.status) === "confirmed") return true;
  return SHORT_COMPLETION.test(text.trim()) && (resetContext(post.quote_context, posts) ||
    resetContext(posts.get(String(post.in_reply_to_tweet_id || "")), posts));
}

export function archiveResetRecords(events, now = Date.now()) {
  const range = windowRange(now);
  return (Array.isArray(events) ? events : []).filter((event) => event?.source === "archive" &&
    event.type === "reset" && event.reset_kind !== "banked" && event.preview !== true &&
    validUrl(event.url, event.id) && typeof event.summary === "string" &&
    !BANKED_CONTEXT.test(event.summary) && ARCHIVE_COMPLETION.test(event.summary) &&
    Number.isFinite(Date.parse(event.announced_at || event.effective_at)))
    .map((event) => ({ id: event.id, url: event.url, at: event.announced_at || event.effective_at,
      text: event.summary, level: "reported", source: "codex-reset-archive", source_url: "https://codex-reset.com/" }))
    .filter((record) => dayKey(record.at) >= range.start && dayKey(record.at) <= range.end && Date.parse(record.at) <= now);
}

// FxTwitter 的单帖接口仅用于补齐已知历史 ID，不能把第三方摘要当作原文。
export function calendarOriginal(status, depth = 0) {
  if (!status || depth > 3 || String(status.author?.screen_name || "").toLowerCase() !== "thsottiaux") return null;
  const timestamp = Number(status.created_timestamp) * 1000;
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null;
  const post = { id: String(status.id), url: status.url, text: status.text, at: new Date(timestamp).toISOString(),
    in_reply_to_tweet_id: String(status.replying_to_status || status.replying_to?.status || "") || null };
  if (!validPost(post)) return null;
  const quote = calendarOriginal(status.quote, depth + 1);
  if (quote) post.quote_context = quote;
  return post;
}

export function collectResetHistory({ posts = [], signals = [], archives = [], previous = [] }, now = Date.now()) {
  const range = windowRange(now);
  const records = new Map();
  function remember(record) {
    if (!record || !validUrl(record.url, record.id) || !["confirmed", "reported"].includes(record.level) ||
        typeof record.text !== "string" || !record.text.trim() || record.text.length > MAX_TEXT_LENGTH ||
        !["tibo-original", "codex-reset-archive", "tokenreset-archive", "rss-bz-telegram"].includes(record.source) ||
        !Number.isFinite(Date.parse(record.at)) || Date.parse(record.at) > now) return;
    if (record.level === "confirmed" && record.source !== "tibo-original") return;
    const day = dayKey(record.at);
    if (day < range.start || day > range.end) return;
    if (record.source === "rss-bz-telegram" && !/^https:\/\/t\.me\/ai_pulse_zh\/\d+$/.test(record.source_url)) return;
    if (record.source === "tokenreset-archive" && record.source_url !== "https://token.jacobai.app/") return;
    const old = records.get(record.id);
    if (!old || record.level === "confirmed" || old.level !== "confirmed") records.set(record.id, { ...record, date: day });
  }
  previous.forEach(remember);
  archives.forEach(remember);
  for (const signal of signals) {
    if (signal?.status === "confirmed" && signal.source === "rss-bz-telegram") remember({
      id: signal.id, url: signal.url, at: signal.published_at, text: signal.summary,
      level: "reported", source: signal.source, source_url: signal.source_url,
    });
  }
  const postMap = new Map(posts.filter(validPost).map((post) => [post.id, post]));
  for (const post of postMap.values()) {
    if (confirmedPost(post, postMap)) remember({ id: post.id, url: post.url, at: post.at, text: post.text,
      level: "confirmed", source: "tibo-original", source_url: post.url });
  }
  return [...records.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, HISTORY_LIMIT);
}

export function buildResetCalendar(records, now = Date.now()) {
  const range = windowRange(now);
  const history = collectResetHistory({ previous: records }, now);
  const days = Array.from({ length: WINDOW_DAYS }, (_, index) => {
    const date = new Date(range.firstDay + index * DAY_MS).toISOString().slice(0, 10);
    const items = history.filter((record) => record.date === date);
    return { date, status: items.some((item) => item.level === "confirmed") ? "confirmed" : items.length ? "reported" : "unknown", records: items };
  });
  return { timezone: "Asia/Shanghai", start: range.start, end: range.end, days,
    confirmed_days: days.filter((day) => day.status === "confirmed").length,
    reported_days: days.filter((day) => day.status === "reported").length,
    note: "按确认帖或第三方完成报告的发布时间归日；未记录不等于未重置，不统计预告或重置卡。历史资料可能不完整。" };
}
