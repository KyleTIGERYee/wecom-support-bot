const $ = (id) => document.getElementById(id);

const MAX_CONCURRENCY = 4;
const TRACE_PAGE_SIZE = 30;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const UNRECOGNIZED_PREFIX = "未识别用户 ";
const AUDIT_FOOTER_TEXT = "模型答复来自本机 pi 会话；投递仅为通道状态。";

const els = {
  sidebar: $("sidebar"),
  refresh: $("refresh"),
  prevDay: $("prev-day"),
  nextDay: $("next-day"),
  latestDay: $("latest-day"),
  dateLabel: $("date-label"),
  dateInput: $("date-input"),
  colleagueSelect: $("colleague-select"),
  search: $("search"),
  sessionList: $("session-list"),
  sidebarStats: $("sidebar-stats"),
  scrim: $("scrim"),
  menuButton: $("menu-button"),
  sessionTitle: $("session-title"),
  sessionMeta: $("session-meta"),
  error: $("error"),
  conversation: $("conversation"),
  conversationInner: $("conversation-inner"),
  footer: document.querySelector(".boundary-note"),
  imageDialog: $("image-dialog"),
  dialogImage: $("dialog-image"),
  dialogFallback: $("dialog-fallback"),
  dialogClose: $("dialog-close"),
};

if (els.footer) els.footer.textContent = AUDIT_FOOTER_TEXT;
if (els.imageDialog) {
  els.imageDialog.setAttribute("aria-label", "查看入站图片");
  els.imageDialog.setAttribute("aria-modal", "true");
}

const state = {
  meta: null,
  day: null,
  dayError: null,
  date: null,
  query: "",
  colleagueId: "",
  sessionKey: "",
  dayToken: 0,
  detailEpoch: 0,
  details: new Map(),
  queue: [],
  active: 0,
  expandedTimelines: new Set(),
  expandedTraceFull: new Set(),
  colleagueNames: new Map(),
  refreshing: false,
  turnCards: new Map(),
};

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function displayColleagueName(name) {
  const value = typeof name === "string" ? name : "";
  if (!value.startsWith(UNRECOGNIZED_PREFIX)) return value;
  const id = value.slice(UNRECOGNIZED_PREFIX.length).trim();
  if (!id) return value;
  const tail = id.length > 6 ? `…${id.slice(-6)}` : id;
  return `未识别用户 · ${tail}`;
}

function appendInline(container, text) {
  let index = 0;
  while (index < text.length) {
    const boldIndex = text.indexOf("**", index);
    const codeIndex = text.indexOf("`", index);
    let next = -1;
    let kind = "";
    if (boldIndex !== -1 && (codeIndex === -1 || boldIndex < codeIndex)) {
      next = boldIndex;
      kind = "bold";
    } else if (codeIndex !== -1) {
      next = codeIndex;
      kind = "code";
    }
    if (next === -1) {
      container.append(document.createTextNode(text.slice(index)));
      return;
    }
    if (next > index) container.append(document.createTextNode(text.slice(index, next)));
    if (kind === "code") {
      const end = text.indexOf("`", next + 1);
      if (end === -1) {
        container.append(document.createTextNode("`"));
        index = next + 1;
        continue;
      }
      container.append(el("code", "md-code", text.slice(next + 1, end)));
      index = end + 1;
      continue;
    }
    const end = text.indexOf("**", next + 2);
    if (end === -1) {
      container.append(document.createTextNode("**"));
      index = next + 2;
      continue;
    }
    const strong = el("strong");
    appendInline(strong, text.slice(next + 2, end));
    container.append(strong);
    index = end + 2;
  }
}

function renderRichText(value, className) {
  const root = el("div", `${className} md-content`);
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      const title = el("h3", "md-heading");
      appendInline(title, heading[2]);
      root.append(title);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const list = el("ul", "md-list");
      while (index < lines.length) {
        const item = /^[-*]\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        const li = el("li");
        appendInline(li, item[1]);
        list.append(li);
        index += 1;
      }
      root.append(list);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const list = el("ol", "md-list");
      while (index < lines.length) {
        const item = /^\d+\.\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        const li = el("li");
        appendInline(li, item[1]);
        list.append(li);
        index += 1;
      }
      root.append(list);
      continue;
    }
    const paragraph = el("p", "md-p");
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim() || /^(#{2,3})\s+/.test(current) || /^[-*]\s+/.test(current) || /^\d+\.\s+/.test(current)) break;
      if (paragraph.childNodes.length) paragraph.append(el("br"));
      appendInline(paragraph, current);
      index += 1;
    }
    if (paragraph.childNodes.length) root.append(paragraph);
  }
  return root;
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body && typeof body.error === "string" ? body.error : `请求失败（${response.status}）`);
  }
  return body;
}

function showError(message) {
  if (!message) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.textContent = message;
  els.error.hidden = false;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

function formatDateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDate(value, amount) {
  const date = parseDateValue(value);
  if (!date) return null;
  return formatDateValue(new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount));
}

function formatDateLabel(value) {
  const date = parseDateValue(value);
  if (!date) return "选择日期";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

function formatTime(value) {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSeconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

function chatLabel(types) {
  const rows = Array.isArray(types) ? types : [];
  const hasGroup = rows.includes("group");
  const hasSingle = rows.includes("single");
  if (hasGroup && hasSingle) return "单聊/群聊";
  return hasGroup ? "群聊" : "单聊";
}

function imageUrl(turnId, index) {
  return `/api/turns/${encodeURIComponent(turnId)}/images/${index}`;
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const date = params.get("date");
  state.date = date && parseDateValue(date) ? date : null;
  state.sessionKey = params.get("session") || "";
  state.query = (params.get("q") || "").trim().slice(0, 200);
  state.colleagueId = params.get("colleague") || "";
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.date) params.set("date", state.date);
  if (state.sessionKey) params.set("session", state.sessionKey);
  if (state.query) params.set("q", state.query);
  if (state.colleagueId) params.set("colleague", state.colleagueId);
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function visibleSessions() {
  const sessions = state.day?.sessions ?? [];
  return sessions.filter((session) => !state.colleagueId || session.colleagueId === state.colleagueId);
}

function selectedSession() {
  return state.day?.sessions.find((session) => session.id === state.sessionKey) ?? null;
}

function currentSessionTurns() {
  if (!state.day || !state.sessionKey) return [];
  return state.day.turns
    .filter((turn) => turn.sessionKey === state.sessionKey && (!state.colleagueId || turn.colleagueId === state.colleagueId))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

function reconcileSession() {
  const sessions = visibleSessions();
  if (!sessions.length) {
    state.sessionKey = "";
    return;
  }
  if (state.sessionKey && sessions.some((session) => session.id === state.sessionKey)) return;
  state.sessionKey = sessions[0].id;
}

function renderDateLabel() {
  els.dateLabel.textContent = formatDateLabel(state.date);
}

function renderColleagueSelect() {
  clear(els.colleagueSelect);
  const all = el("option", "", "全部人员");
  all.value = "";
  all.title = "全部人员";
  els.colleagueSelect.append(all);
  let found = false;
  for (const colleague of state.day?.colleagues ?? []) {
    const option = el("option", "", displayColleagueName(colleague.name));
    option.value = colleague.colleagueId;
    option.title = colleague.name;
    if (colleague.colleagueId === state.colleagueId) found = true;
    els.colleagueSelect.append(option);
  }
  if (state.colleagueId && !found) {
    const fullName = state.colleagueNames.get(state.colleagueId) || "所选人员";
    const option = el("option", "", displayColleagueName(fullName));
    option.value = state.colleagueId;
    option.title = fullName;
    els.colleagueSelect.append(option);
  }
  els.colleagueSelect.value = state.colleagueId;
  els.colleagueSelect.title = state.colleagueId ? state.colleagueNames.get(state.colleagueId) || "所选人员" : "全部人员";
}

function skeletonFragment() {
  const fragment = document.createDocumentFragment();
  const widths = [["w60", "w85", "w40"], ["w55", "w75", "w45"], ["w65", "w80", "w35"]];
  for (const row of widths) {
    const box = el("div", "session-skeleton");
    box.setAttribute("aria-hidden", "true");
    box.append(el("span", `skeleton-line ${row[0]}`), el("span", `skeleton-line ${row[1]}`), el("span", `skeleton-line ${row[2]}`));
    fragment.append(box);
  }
  return fragment;
}

function sidebarEmpty(title, hint = "") {
  const box = el("div", "sidebar-empty");
  box.append(el("div", "", title));
  if (hint) box.append(el("div", "sidebar-empty-hint", hint));
  return box;
}

function renderSessionList() {
  const scrollTop = els.sessionList.scrollTop;
  clear(els.sessionList);
  if (!state.day) {
    if (state.dayError) els.sessionList.append(sidebarEmpty("暂时读不出来", "点右上角刷新再试"));
    else if (state.meta) els.sessionList.append(sidebarEmpty("还没有对话记录", "本机还没有可读的提问日志"));
    else els.sessionList.append(skeletonFragment());
    return;
  }
  const sessions = visibleSessions();
  if (!sessions.length) {
    const filtered = state.query || state.colleagueId;
    els.sessionList.append(filtered ? sidebarEmpty("没有匹配的会话", "换一天或清空搜索") : sidebarEmpty("这一天还没有对话", "换一天或点“最近”"));
    return;
  }
  for (const session of sessions) {
    const button = el("button", "session-item");
    button.type = "button";
    button.dataset.sessionId = session.id;
    button.title = session.firstQuestion ? `${session.colleagueName}：${session.firstQuestion}` : session.colleagueName;
    if (session.id === state.sessionKey) button.setAttribute("aria-current", "true");
    const top = el("div", "session-top");
    top.append(el("span", "session-name", displayColleagueName(session.colleagueName)), el("span", "session-time", formatTime(session.lastAt)));
    const preview = el("div", "session-preview", session.firstQuestion || "（仅图片或没有文字）");
    const meta = el("div", "session-meta", `${session.questions} 轮 · ${chatLabel(session.chatTypes)}`);
    button.append(top, preview, meta);
    button.addEventListener("click", () => selectSession(session.id));
    els.sessionList.append(button);
  }
  els.sessionList.scrollTop = scrollTop;
}

function renderStats() {
  if (!state.day) {
    els.sidebarStats.textContent = "";
    return;
  }
  const sessions = visibleSessions();
  const questions = sessions.reduce((sum, session) => sum + session.questions, 0);
  const colleagues = new Set(sessions.map((session) => session.colleagueId)).size;
  els.sidebarStats.textContent = `${questions} 次提问 · ${colleagues} 位同事 · ${sessions.length} 个会话`;
}

function renderSidebar() {
  renderColleagueSelect();
  renderSessionList();
  renderStats();
}

function renderMainHeader() {
  const session = selectedSession();
  if (!session) {
    els.sessionTitle.textContent = "对话审计";
    els.sessionTitle.removeAttribute("title");
    els.sessionMeta.textContent = state.dayError ? "暂时读不出来" : state.day ? "从左侧选择一个会话" : "正在读取…";
    return;
  }
  const shownName = displayColleagueName(session.colleagueName);
  els.sessionTitle.textContent = typeof session.generation === "number" ? `${shownName} · g${session.generation}` : shownName;
  els.sessionTitle.title = session.colleagueName;
  const start = formatTime(session.startedAt);
  const end = formatTime(session.lastAt);
  const span = start && end ? (start === end ? start : `${start}–${end}`) : start || end;
  els.sessionMeta.textContent = [`${session.questions} 轮`, span, chatLabel(session.chatTypes)].filter(Boolean).join(" · ");
}

function emptyState(title, hint) {
  els.conversationInner.classList.add("is-empty");
  const box = el("div", "empty-state");
  box.append(el("p", "empty-title", title), el("p", "empty-hint", hint));
  els.conversationInner.append(box);
}

function renderConversation() {
  clear(els.conversationInner);
  state.turnCards.clear();
  if (!state.day) {
    if (state.dayError) {
      emptyState(state.meta ? "这一天暂时读不出来" : "看板暂时无法读取", `读取出错：${state.dayError}。可以点右上角刷新再试。`);
    } else if (state.meta) {
      emptyState("还没有任何对话记录", "本机还没有可读的提问日志。");
    } else {
      emptyState("正在读取…", "从本机日志整理对话记录");
    }
    return;
  }
  const session = selectedSession();
  const sessions = visibleSessions();
  if (!sessions.length) {
    const filtered = state.query || state.colleagueId;
    emptyState(filtered ? "没有找到匹配的会话" : "这一天还没有对话", filtered ? "试试清空搜索，或换一天。" : "换一个日期，或者点“最近”。");
    return;
  }
  if (!session) {
    emptyState("没有可显示的会话", "换一天，或切换到“全部人员”。");
    return;
  }
  const turns = currentSessionTurns();
  if (!turns.length) {
    emptyState("这个会话没有可显示的提问", "换一个会话看看。");
    return;
  }
  els.conversationInner.classList.remove("is-empty");
  for (const turn of turns) {
    const card = buildTurnCard(turn);
    state.turnCards.set(turn.id, card);
    els.conversationInner.append(card);
  }
}

function buildTurnCard(turn) {
  const article = el("article", "turn");
  article.dataset.turnId = turn.id;
  article.append(buildQuestion(turn), buildAnswer(turn));
  return article;
}

function buildQuestion(turn) {
  const wrapper = el("div", "question");
  wrapper.append(el("div", "question-time", formatTime(turn.receivedAt)));
  const bubble = el("div", "bubble");
  const questionText = renderRichText(turn.question || "（仅图片或没有文字）", "question-text");
  if (!turn.question) questionText.classList.add("empty-text");
  bubble.append(questionText);
  if (turn.questionTruncated) bubble.append(el("p", "question-note", "原始问题过长，页面仅显示上限内的内容。"));
  const entry = state.details.get(turn.id);
  if (entry?.status === "ok") {
    const actual = Array.isArray(entry.data.images) ? entry.data.images : [];
    const rawCount = Number.isInteger(entry.data.imageCount) ? entry.data.imageCount : turn.imageCount;
    const expected = Math.max(Number.isInteger(rawCount) ? rawCount : 0, ...actual.map((image) => image.index), 0);
    if (expected > 0) {
      const row = el("div", "question-images");
      const byIndex = new Map(actual.map((image) => [image.index, image]));
      for (let index = 1; index <= expected; index += 1) {
        const image = byIndex.get(index);
        row.append(image ? buildThumbnail(turn.id, image) : el("div", "image-fallback", "图片不可用"));
      }
      bubble.append(row);
    }
  }
  wrapper.append(bubble);
  return wrapper;
}

function buildThumbnail(turnId, image) {
  const button = el("button", "image-thumb");
  button.type = "button";
  button.setAttribute("aria-label", `查看第 ${image.index} 张图片`);
  const img = el("img");
  img.alt = `第 ${image.index} 张入站图片`;
  img.loading = "lazy";
  img.addEventListener("error", () => {
    button.replaceWith(el("div", "image-fallback", "图片不可用"));
  }, { once: true });
  img.src = imageUrl(turnId, image.index);
  button.append(img);
  button.addEventListener("click", () => openImage(turnId, image.index));
  return button;
}

function answerTime(turn) {
  const base = Date.parse(turn.receivedAt ?? "");
  if (Number.isFinite(turn.durationMs) && turn.durationMs >= 0 && Number.isFinite(base)) return formatTime(base + turn.durationMs);
  return formatTime(turn.receivedAt);
}

function buildAnswerMeta(turn, detail) {
  const meta = el("div", "answer-meta");
  const delivery = detail.delivery ?? {};
  const infoParts = [];
  const time = answerTime(turn);
  if (time) infoParts.push(time);
  if (detail.orchestration?.route) infoParts.push(detail.orchestration.route.toUpperCase());
  const duration = formatSeconds(turn.durationMs);
  if (duration) infoParts.push(duration);
  if (infoParts.length) {
    const info = el("span", "answer-meta-info");
    infoParts.forEach((part, index) => {
      if (index) info.append(document.createTextNode(" · "));
      info.append(document.createTextNode(part));
    });
    meta.append(info);
  }
  let statusText = "处理中";
  let statusDanger = false;
  if (delivery.status === "delivered") {
    statusText = "已投递";
  } else if (delivery.status === "failed") {
    statusText = "投递失败";
    statusDanger = true;
  } else if (detail.orchestration) {
    statusText = "投递未确认";
  }
  const deliveryParts = [statusText];
  if (delivery.channel === "stream") deliveryParts.push("流式");
  else if (delivery.channel === "push") deliveryParts.push("推送");
  else if (delivery.channel === "none") deliveryParts.push("无通道");
  meta.append(el("span", statusDanger ? "answer-meta-delivery is-danger" : "answer-meta-delivery", deliveryParts.join(" · ")));
  if (detail.orchestration?.guarded) meta.append(el("span", "answer-meta-note", "Guard 重写"));
  return meta;
}

function buildAnswer(turn) {
  const box = el("div", "answer");
  const entry = state.details.get(turn.id);
  if (!entry || entry.status === "loading") {
    const loading = el("div", "loading-block");
    loading.append(el("div", "loading-text", "正在读取这一轮…"), el("span", "skeleton-line w85"), el("span", "skeleton-line w60"));
    box.append(loading);
    return box;
  }
  if (entry.status === "error") {
    box.append(el("p", "muted-line", `这一轮读取失败：${entry.message}`));
    const retry = el("button", "link-button", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => retryDetail(turn.id));
    box.append(retry);
    return box;
  }
  const detail = entry.data;
  box.append(buildAnswerMeta(turn, detail));
  if (detail.answer?.text) {
    box.append(renderRichText(detail.answer.text, "answer-text"));
    if (detail.answer.truncated) box.append(el("p", "answer-note", "答复达到长度上限，当前内容不完整。"));
  } else {
    box.append(el("p", "muted-line", "没有可核验的模型最终答复"));
  }
  box.append(buildTrace(turn, detail));
  return box;
}

function buildTrace(turn, detail) {
  const timeline = Array.isArray(detail.timeline) ? detail.timeline : [];
  if (!timeline.length) return el("p", "muted-line", "这轮没有留下可核验的执行轨迹");
  const expanded = state.expandedTimelines.has(turn.id);
  const counts = detail.counts ?? {};
  const toggle = el("button", "trace-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.title = expanded ? "收起执行轨迹" : "展开执行轨迹";
  const chevron = el("span", "chevron", expanded ? "▴" : "▾");
  toggle.append(el("span", "", `执行轨迹 ${timeline.length} 步`), chevron);
  toggle.append(el("span", "trace-counts", `thinking ${counts.thinking ?? 0} · 文档 ${counts.documentReads ?? 0} · 工具 ${counts.toolCalls ?? 0}`));
  const trace = el("div", "trace");
  trace.hidden = !expanded;
  const showAll = state.expandedTraceFull.has(turn.id);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const visible = showAll ? timeline : timeline.slice(0, TRACE_PAGE_SIZE);
    for (const event of visible) trace.append(buildTraceEvent(event));
    const remaining = timeline.length - visible.length;
    if (remaining > 0) {
      const moreWrap = el("div", "trace-more");
      const more = el("button", "trace-more-button", `展开其余 ${remaining} 条`);
      more.type = "button";
      more.addEventListener("click", () => {
        state.expandedTraceFull.add(turn.id);
        trace.replaceChildren();
        for (const event of timeline) trace.append(buildTraceEvent(event));
      });
      moreWrap.append(more);
      trace.append(moreWrap);
    }
  };
  if (expanded) fill();
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    toggle.title = open ? "展开执行轨迹" : "收起执行轨迹";
    chevron.textContent = open ? "▾" : "▴";
    trace.hidden = open;
    if (open) {
      state.expandedTimelines.delete(turn.id);
    } else {
      state.expandedTimelines.add(turn.id);
      fill();
    }
  });
  const wrapper = el("div", "trace-wrap");
  wrapper.append(toggle, trace);
  return wrapper;
}

function appendTags(container, tags) {
  for (const tag of tags) {
    const text = typeof tag === "string" ? tag : tag.text;
    const danger = typeof tag === "object" && tag.danger === true;
    container.append(el("span", danger ? "tag tag-danger" : "tag", text));
  }
}

function traceHead(title, at, tags = []) {
  const head = el("div", "trace-head");
  head.append(el("span", "trace-title", title));
  appendTags(head, tags);
  const time = formatTime(at);
  if (time) head.append(el("span", "trace-time", time));
  return head;
}

function traceSummary(title, at, tags = []) {
  const summary = el("summary");
  summary.append(el("span", "trace-title", title));
  appendTags(summary, tags);
  const time = formatTime(at);
  if (time) summary.append(el("span", "trace-time", time));
  return summary;
}

function toolLabel(event) {
  if (event.isSkillRead) {
    return event.result && !event.result.isError ? "实际读取 SKILL.md · 已加载" : "实际读取 SKILL.md";
  }
  switch (event.name) {
    case "read":
      return "读取文档";
    case "bash":
      return "运行命令";
    case "write":
      return "写入文件";
    case "edit":
      return "编辑文件";
    case "ls":
      return "查看目录";
    default:
      return `调用工具 ${event.name}`;
  }
}

function buildToolCall(event) {
  const fragment = document.createDocumentFragment();
  const tags = [];
  if (event.result?.isError) tags.push({ text: "失败", danger: true });
  if (event.missingResult) tags.push("结果未落盘");
  if (event.result?.truncated) tags.push("已截断");
  fragment.append(traceHead(toolLabel(event), event.at, tags));
  const args = event.arguments ?? {};
  if (args.path) fragment.append(el("code", "trace-path", args.path));
  if (event.name === "bash" && args.command && typeof args.command.text === "string") {
    fragment.append(el("pre", "trace-command", args.command.text || "（空命令）"));
  }
  if (event.name === "read" && (Number.isFinite(args.offset) || Number.isFinite(args.limit))) {
    fragment.append(el("p", "trace-note", `读取区间：offset=${Number.isFinite(args.offset) ? args.offset : "默认"} · limit=${Number.isFinite(args.limit) ? args.limit : "默认"}`));
  }
  if (event.name === "write" && args.content && typeof args.content.text === "string") {
    const details = el("details", "trace-details");
    details.append(traceSummary("查看写入内容", null));
    details.append(el("pre", "trace-pre", args.content.text || "（空内容）"));
    if (args.content.truncated) details.append(el("p", "trace-note", "写入内容已按页面上限截断。"));
    fragment.append(details);
  }
  if (event.name === "edit" && Array.isArray(args.edits) && args.edits.length) {
    const details = el("details", "trace-details");
    details.append(traceSummary("查看改动", null));
    args.edits.forEach((edit, index) => {
      details.append(el("p", "trace-note", `改动 ${index + 1}`));
      details.append(el("pre", "trace-pre", `原内容：\n${edit.oldText?.text ?? ""}\n\n新内容：\n${edit.newText?.text ?? ""}`));
      if (edit.oldText?.truncated || edit.newText?.truncated) details.append(el("p", "trace-note", "改动内容已按页面上限截断。"));
    });
    fragment.append(details);
  }
  if (event.result) {
    const details = el("details", "trace-details");
    details.append(traceSummary("查看结果", null));
    details.append(el("pre", "trace-pre", event.result.text || "（无文本结果）"));
    if (event.result.truncated) {
      details.append(el("p", "trace-note", event.result.totalLines ? `已截断，共约 ${event.result.totalLines} 行；这里不是完整结果。` : "已截断，这里不是完整结果。"));
    }
    fragment.append(details);
  }
  return fragment;
}

function buildOrphanResult(event) {
  const fragment = document.createDocumentFragment();
  const tags = [];
  if (event.result?.isError) tags.push({ text: "失败", danger: true });
  if (event.result?.truncated) tags.push("已截断");
  fragment.append(traceHead(`工具结果 · ${event.name}`, event.at, tags));
  fragment.append(el("p", "trace-note", "没有配对到工具调用，历史记录可能不完整。"));
  if (event.result) {
    const details = el("details", "trace-details");
    details.append(traceSummary("查看结果", null));
    details.append(el("pre", "trace-pre", event.result.text || "（无文本结果）"));
    if (event.result.truncated) details.append(el("p", "trace-note", "已截断，这里不是完整结果。"));
    fragment.append(details);
  }
  return fragment;
}

function buildTraceEvent(event) {
  const row = el("div", "trace-event");
  if (event.type === "thinking") {
    const details = el("details", "trace-details");
    details.append(traceSummary("思考过程", event.at, event.truncated ? ["已截断"] : []));
    details.append(el("div", "thinking-body", event.text || "（无内容）"));
    row.append(details);
    return row;
  }
  if (event.type === "toolCall") {
    row.append(buildToolCall(event));
    return row;
  }
  if (event.type === "toolResult") {
    row.append(buildOrphanResult(event));
    return row;
  }
  if (event.type === "guardRework") {
    row.append(traceHead("隐私检查未通过，要求重写", event.at));
    if (event.reason) row.append(el("p", "trace-note", `原因：${event.reason}`));
    return row;
  }
  if (event.type === "progressiveDepth") {
    row.append(traceHead("继续补充资料", event.at));
    return row;
  }
  if (event.type === "modelStop") {
    row.append(traceHead(event.reason === "length" ? "模型在长度上限停止" : "模型返回错误", event.at));
    if (event.text) row.append(el("p", "trace-note", event.text));
    return row;
  }
  if (event.type === "notice") {
    row.append(el("p", "trace-note", event.text || "时间线过长，部分事件未显示。"));
    return row;
  }
  if (event.type === "modelText") {
    const details = el("details", "trace-details");
    details.append(traceSummary("模型输出", event.at, event.truncated ? ["已截断"] : []));
    details.append(el("pre", "trace-pre", event.text || "（无内容）"));
    row.append(details);
    return row;
  }
  row.append(el("p", "trace-note", `未知事件：${event.type}`));
  return row;
}

function openImage(turnId, index) {
  els.dialogImage.hidden = true;
  els.dialogFallback.hidden = true;
  els.dialogImage.alt = `第 ${index} 张入站图片`;
  els.dialogImage.src = imageUrl(turnId, index);
  if (!els.imageDialog.open) {
    if (typeof els.imageDialog.showModal === "function") els.imageDialog.showModal();
    else els.imageDialog.setAttribute("open", "");
  }
}

function refreshTurnCard(id) {
  const current = state.turnCards.get(id);
  if (!current || !current.isConnected) return;
  const turn = currentSessionTurns().find((item) => item.id === id);
  if (!turn) return;
  const next = buildTurnCard(turn);
  current.replaceWith(next);
  state.turnCards.set(id, next);
}

function pumpQueue() {
  while (state.active < MAX_CONCURRENCY && state.queue.length) {
    const id = state.queue.shift();
    const entry = id ? state.details.get(id) : null;
    if (!id || !entry || entry.status !== "loading") continue;
    state.active += 1;
    void runDetailFetch(id);
  }
}

async function runDetailFetch(id) {
  const epoch = state.detailEpoch;
  try {
    const data = await api(`/api/turns/${encodeURIComponent(id)}`);
    if (epoch !== state.detailEpoch) return;
    state.details.set(id, { status: "ok", data });
  } catch (error) {
    if (epoch !== state.detailEpoch) return;
    state.details.set(id, { status: "error", message: error.message });
  } finally {
    state.active -= 1;
    if (epoch === state.detailEpoch) refreshTurnCard(id);
    pumpQueue();
  }
}

function requestDetail(id) {
  const entry = state.details.get(id);
  if (entry && (entry.status === "loading" || entry.status === "ok")) return;
  state.details.set(id, { status: "loading" });
  state.queue.push(id);
  pumpQueue();
}

function loadSessionDetails() {
  for (const turn of currentSessionTurns()) {
    if (!state.details.has(turn.id)) requestDetail(turn.id);
  }
}

function retryDetail(id) {
  state.details.delete(id);
  refreshTurnCard(id);
  requestDetail(id);
}

function focusSessionButton(id) {
  if (!window.matchMedia("(min-width: 960px)").matches) return;
  const target = [...els.sessionList.querySelectorAll(".session-item")].find((button) => button.dataset.sessionId === id);
  if (target) target.focus({ preventScroll: true });
}

function selectSession(id) {
  if (state.sessionKey !== id) state.sessionKey = id;
  renderSessionList();
  renderMainHeader();
  renderConversation();
  syncUrl();
  loadSessionDetails();
  els.conversation.scrollTop = 0;
  closeDrawer();
  focusSessionButton(id);
}

async function loadDay() {
  const token = ++state.dayToken;
  state.dayError = null;
  const params = new URLSearchParams();
  if (state.date) params.set("date", state.date);
  if (state.query) params.set("q", state.query);
  try {
    const day = await api(`/api/day?${params.toString()}`);
    if (token !== state.dayToken) return;
    state.day = day;
    state.dayError = null;
    if (day.date) {
      state.date = day.date;
      els.dateInput.value = state.date;
    }
    renderDateLabel();
    for (const colleague of day.colleagues ?? []) state.colleagueNames.set(colleague.colleagueId, colleague.name);
    reconcileSession();
    renderSidebar();
    renderMainHeader();
    renderConversation();
    syncUrl();
    loadSessionDetails();
    showError("");
  } catch (error) {
    if (token !== state.dayToken) return;
    state.day = null;
    state.dayError = error.message;
    renderSidebar();
    renderMainHeader();
    renderConversation();
    syncUrl();
  }
}

function openDrawer() {
  els.sidebar.classList.add("open");
  els.scrim.hidden = false;
  els.menuButton.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  els.sidebar.classList.remove("open");
  els.scrim.hidden = true;
  els.menuButton.setAttribute("aria-expanded", "false");
}

function drawerOpen() {
  return els.sidebar.classList.contains("open");
}

async function refreshData() {
  if (state.refreshing) return;
  state.refreshing = true;
  els.refresh.disabled = true;
  els.refresh.classList.add("refreshing");
  try {
    await api("/api/refresh", { method: "POST" });
    const meta = await api("/api/bootstrap");
    state.meta = meta;
    state.detailEpoch += 1;
    state.details.clear();
    state.queue.length = 0;
    state.expandedTimelines.clear();
    state.expandedTraceFull.clear();
    if (!state.date) {
      state.date = meta.defaultDate;
      if (state.date) els.dateInput.value = state.date;
    }
    await loadDay();
    showError("");
  } catch (error) {
    showError(`刷新失败：${error.message}`);
  } finally {
    state.refreshing = false;
    els.refresh.disabled = false;
    els.refresh.classList.remove("refreshing");
  }
}

let searchTimer = null;

function applySearch() {
  const value = els.search.value.trim();
  if (value === state.query) return;
  state.query = value;
  loadDay();
}

async function initialize() {
  readUrlState();
  if (state.query) els.search.value = state.query;
  try {
    const meta = await api("/api/bootstrap");
    state.meta = meta;
    if (!state.date) state.date = meta.defaultDate;
    if (state.date) els.dateInput.value = state.date;
    renderDateLabel();
    if (state.date) {
      await loadDay();
    } else {
      renderSidebar();
      renderMainHeader();
      renderConversation();
      syncUrl();
    }
  } catch (error) {
    state.dayError = error.message;
    showError("");
    renderDateLabel();
    renderSidebar();
    renderMainHeader();
    renderConversation();
  }
}

els.prevDay.addEventListener("click", () => {
  const next = shiftDate(state.date, -1);
  if (!next) return;
  state.date = next;
  els.dateInput.value = next;
  renderDateLabel();
  loadDay();
});

els.nextDay.addEventListener("click", () => {
  const next = shiftDate(state.date, 1);
  if (!next) return;
  state.date = next;
  els.dateInput.value = next;
  renderDateLabel();
  loadDay();
});

els.latestDay.addEventListener("click", () => {
  const latest = state.meta?.dates?.at(-1) || state.meta?.defaultDate;
  if (!latest) return;
  state.date = latest;
  els.dateInput.value = latest;
  renderDateLabel();
  loadDay();
});

els.dateInput.addEventListener("change", () => {
  const value = els.dateInput.value;
  if (!parseDateValue(value)) {
    els.dateInput.value = state.date || "";
    return;
  }
  state.date = value;
  renderDateLabel();
  loadDay();
});

els.colleagueSelect.addEventListener("change", () => {
  state.colleagueId = els.colleagueSelect.value;
  els.colleagueSelect.title = state.colleagueId ? state.colleagueNames.get(state.colleagueId) || "所选人员" : "全部人员";
  reconcileSession();
  renderSessionList();
  renderStats();
  renderMainHeader();
  renderConversation();
  syncUrl();
  loadSessionDetails();
});

els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, 250);
});

els.search.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(searchTimer);
  applySearch();
});

els.refresh.addEventListener("click", () => {
  void refreshData();
});

els.menuButton.addEventListener("click", () => {
  if (drawerOpen()) closeDrawer();
  else openDrawer();
});

els.scrim.addEventListener("click", closeDrawer);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !drawerOpen()) return;
  closeDrawer();
  els.menuButton.focus();
});

window.matchMedia("(min-width: 960px)").addEventListener("change", (event) => {
  if (event.matches) closeDrawer();
});

els.dialogClose.addEventListener("click", () => {
  if (typeof els.imageDialog.close === "function") els.imageDialog.close();
  else els.imageDialog.removeAttribute("open");
});

els.imageDialog.addEventListener("click", (event) => {
  if (event.target !== els.imageDialog) return;
  if (typeof els.imageDialog.close === "function") els.imageDialog.close();
  else els.imageDialog.removeAttribute("open");
});

els.dialogImage.addEventListener("load", () => {
  els.dialogImage.hidden = false;
  els.dialogFallback.hidden = true;
});

els.dialogImage.addEventListener("error", () => {
  els.dialogImage.hidden = true;
  els.dialogFallback.hidden = false;
});

void initialize();
