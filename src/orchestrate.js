/**
 * 轮次编排：把「跑 agent → 隐私判定 → 打回重写」串成一个完整的同事提问处理流程。
 *
 * 关键约束：agent 的原始输出在 guard 通过前绝不外发。DENY 时只把理由回灌给 agent
 * 让它重写，绝不把原答复带给调用方。
 */

import { dirname } from "node:path";

import { getLoadDepth } from "./resource-catalog.js";
import { hasAttachedFiles, stripSystemSupplement } from "./files.js";

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_FALLBACK_TEXT = "这条涉及生产数据，我没法直接确认。建议直接问虎老师。";
const DEFAULT_ERROR_TEXT = "刚才没处理好，你再问一次？";
const DEFAULT_TIMEOUT_TEXT = "这个我查得有点久，还没查准。你换个说法我再试试，或者直接找虎老师更快。";
const DATA_EVIDENCE_READ_INSTRUCTION = "历史经验、指标卡、SQL 和表文档都必须用 read 工具实际读取；cat、grep、rg 只用于定位，不能代替 read 证据。";
const TRUSTED_DATA_BUSINESS_LINES = [
  ["ajly", "安居乐寓"],
  ["lzz", "乐租租"],
];

/**
 * @typedef {{
 *   source: string,
 *   path: string,
 *   depth: string,
 *   resourceType?: string,
 *   sourceTime?: string|null,
 *   copiedAt?: string|null,
 *   validity?: string,
 *   scope?: string,
 *   verification?: string
 *   skillName?: string
 *   skillResourceType?: string
 * }} LoadedResource
 */

/**
 * @param {{
 *   question: string,
 *   sessionKey: string,
 *   deps: {
 *     state: {isBiTouched: (key: string) => boolean, markBiTouched: (key: string) => void, flush: () => Promise<void>},
 *     runAgent: (options: {prompt: string, sessionId: string, isRework: boolean, currentSkill: string}) => Promise<{text: string, biTouched: boolean, timedOut: boolean, stalled: boolean, failed: boolean, contextInsufficient?: boolean, loadedResources?: Array<LoadedResource>, executionApprovals?: Array<any>}>,
 *     review: (options: {answer: string}) => Promise<{verdict: "ALLOW"|"DENY", reason?: string}>,
 *     context?: {catalog?: string, dataPlaybook?: boolean, entries?: Array<LoadedResource>, skills?: Array<any>, workspaceDir?: string, trustedDataScripts?: Record<string, string>}
 *   },
 *   maxRounds?: number,
 *   messages?: {fallbackText?: string, errorText?: string, timeoutText?: string}
 * }} options
 * @returns {Promise<{finalText: string, rounds: number, guarded: boolean, exhausted: boolean, timedOut?: boolean, stalled?: boolean, stallRetries?: number, lastDenyReason?: string, currentSkill: string, loadedSkills: Array<LoadedResource>, loadedResources: Array<LoadedResource>, executionApprovals: Array<any>, loadDepth: string}>}
 */
export async function handleTurn({ question, sessionKey, deps, maxRounds = DEFAULT_MAX_ROUNDS, messages = {} }) {
  const { state, runAgent, review } = deps;
  const fallbackText = messages.fallbackText ?? DEFAULT_FALLBACK_TEXT;
  const errorText = messages.errorText ?? DEFAULT_ERROR_TEXT;
  const timeoutText = messages.timeoutText ?? DEFAULT_TIMEOUT_TEXT;

  const rawQuestion = stripSystemSupplement(question);
  const attachedFiles = hasAttachedFiles(question);
  const hasUserText =
    rawQuestion !== "" && !/^（同事(?:只发了(?:图片|文件)|随消息附了图片和文件)，没有附文字）$/.test(rawQuestion);
  const knowledgeTask = classifyKnowledgeTask(rawQuestion);
  const currentSkill = hasUserText ? selectSkill(rawQuestion, deps.context?.skills, knowledgeTask) : undefined;
  let prompt = buildInitialPrompt(
    question,
    deps.context?.catalog,
    knowledgeTask,
    currentSkill,
    deps.context?.workspaceDir,
    deps.context?.trustedDataScripts,
  );
  let lastDenyReason = "";
  let rounds = 0;
  let stallRetries = 0;
  let needGuard = state.isBiTouched(sessionKey);
  /** @type {Array<LoadedResource>} */
  const loadedResources = [];
  /** @type {Array<any>} */
  const executionApprovals = [];
  const observation = () => ({
    currentSkill: currentSkill?.name ?? "unknown",
    loadedSkills: loadedResources.filter((resource) => resource.resourceType === "skill").map((resource) => ({ ...resource })),
    loadedResources: loadedResources.map((resource) => ({ ...resource })),
    executionApprovals: executionApprovals.map((approval) => ({ ...approval })),
    loadDepth: getLoadDepth(loadedResources),
  });

  while (rounds < maxRounds) {
    rounds += 1;
    const isRework = rounds > 1;

    const { turn, retries } = await runWithProgressiveDepth(
      runAgent,
      { prompt, sessionId: sessionKey, isRework, currentSkill: currentSkill?.name ?? "unknown" },
      {
        question: rawQuestion,
        attachedFiles,
        task: knowledgeTask,
        catalog: deps.context?.catalog,
        catalogEntries: deps.context?.entries ?? [],
        dataPlaybook: deps.context?.dataPlaybook,
        trustedDataScripts: deps.context?.trustedDataScripts,
        loadedResources,
        executionApprovals,
      },
    );
    stallRetries += retries;

    // 超时和失败给不同的话术：超时说明查得太久，失败说明出了岔子
    // 卡住（事件流静默）也算超时，因为已经重试过一次还是没动静
    if (turn.timedOut || turn.stalled) {
      return {
        finalText: timeoutText,
        rounds,
        guarded: needGuard,
        exhausted: false,
        timedOut: true,
        stalled: Boolean(turn.stalled),
        stallRetries,
        ...observation(),
      };
    }
    if (turn.failed) {
      return { finalText: errorText, rounds, guarded: needGuard, exhausted: false, ...observation() };
    }

    if (turn.biTouched && !needGuard) {
      needGuard = true;
      state.markBiTouched(sessionKey);
      await state.flush();
    }

    if (!needGuard) {
      return { finalText: turn.text, rounds, guarded: false, exhausted: false, stallRetries, ...observation() };
    }

    const verdict = await review({ answer: turn.text });
    if (verdict.verdict === "ALLOW") {
      return { finalText: turn.text, rounds, guarded: true, exhausted: false, stallRetries, ...observation() };
    }

    lastDenyReason = verdict.reason ?? "答复包含敏感个人信息";
    prompt = buildReworkPrompt(lastDenyReason);
  }

  return {
    finalText: fallbackText,
    rounds,
    guarded: true,
    exhausted: true,
    lastDenyReason,
    ...observation(),
  };
}

/**
 * 首轮只带选择资源所需的目录，不注入资源正文。
 *
 * @param {string} question
 * @param {string|undefined} catalog
 * @param {"concept"|"data"|"history"|"progress"} task
 * @param {any|undefined} skill
 * @param {string|undefined} workspaceDir
 * @param {Record<string, string>|undefined} trustedDataScripts
 */
function buildInitialPrompt(question, catalog, task, skill, workspaceDir, trustedDataScripts) {
  if (!catalog) return question;
  const lines = [
    question,
    "",
    "[渐进式资源目录]",
    "以下目录只用于选择资料，不是资料正文。先用目录和摘要定位，再按需读取概念页；只有当前内容不足以可靠回答时才继续读取相关原始资料。",
    "如果读完概念内容仍不足以可靠回答，请在答复第一行输出 CONTEXT_INSUFFICIENT 并说明缺口；内容充分时正常回答，不输出该标记。",
  ];
  if (workspaceDir) {
    lines.push(
      "[用户任务工作区]",
      `workspace: ${workspaceDir}`,
      "本次任务新建或修改的文档、原型、报告等产物必须使用上述绝对路径并放在该目录内；不要写入主工作区、原始来源或其他目录。标准资源副本修改仍只限目录中的 context 路径，并逐次经过执行审批。",
    );
  }
  if (skill) {
    lines.push(
      "[任务路由：Skill]",
      `current_skill: ${skill.name}`,
      `skill_path: ${skill.path}`,
      "先用 read 读取这个 SKILL.md 的真实正文并遵循；仅正文明确要求且当前任务需要时，才继续读取其 references、模板或 scripts。不要读取其他 Skill 的正文或引用资源。",
    );
  }
  if (task === "data") lines.push(...buildDataPrompt(question, "initial", trustedDataScripts));
  else if (task === "history") lines.push(...buildHistoryPrompt(question, "initial"));
  else if (task === "progress") lines.push(...buildProgressPrompt(question, "initial"));
  lines.push(catalog);
  return lines.join("\n");
}

/** @param {string} question @param {"initial"|"metrics"|"sql"} phase @param {Record<string, string>|undefined} [trustedDataScripts] */
function buildDataPrompt(question, phase, trustedDataScripts) {
  if (phase === "initial") {
    return [
      "[知识任务路由：数据口径]",
      "先确定业务口径，再按手册组合相关历史经验、指标卡、SQL 参考和表文档；不要只搜表名或凭概念页直接给数字。",
      DATA_EVIDENCE_READ_INSTRUCTION,
      ...(trustedDataScripts ? buildTrustedDataPrompt(trustedDataScripts) : []),
    ];
  }
  if (phase === "metrics") {
    return [
      `原始问题：${question}`,
      "这是查数或数据口径任务。先按需读取目录中的 data-playbook 查数手册，再读取相关历史经验和指标卡，确认业务定义、排除条件与统计时间轴；不要凭记忆直接给数字。",
      "新旧口径同时存在时，优先 source_time 最新且 validity=current、明确拍板或生效的资料；history 和历史讨论只用于解释旧口径。无法消解的冲突必须在答复中说明。",
      DATA_EVIDENCE_READ_INSTRUCTION,
    ];
  }
  return [
    `原始问题：${question}`,
    "继续完成数据口径任务：按已确定的指标口径读取相关 SQL 参考和表文档，核对真实表字段、JOIN 条件与过滤条件。",
    "已验证 SQL 只能作为已验证关联路径的参考；未验证、已知问题或没有校验标记的 SQL 不得当成已确认事实，必须重新验证。",
    "不要只凭 SQL 文件名或表名作答。资料仍不足时明确缺少经验、指标卡、SQL 或表文档中的哪一项，以及还缺什么信息。",
    DATA_EVIDENCE_READ_INSTRUCTION,
  ];
}

/** @param {Record<string, string>} trustedDataScripts */
function buildTrustedDataPrompt(trustedDataScripts) {
  const entries = TRUSTED_DATA_BUSINESS_LINES.filter(([businessLine]) => trustedDataScripts[businessLine]);
  if (entries.length === 0) {
    return [
      "[可信只读 BI 入口]",
      "当前实例未配置可用的可信只读 BI 入口。需要真实数字时如实说明缺少该配置；不要执行本地副本中的同名脚本，不要猜测或用文档旧值冒充现查结果。",
    ];
  }
  return [
    "[可信只读 BI 入口]",
    "只执行下列运行时明确配置的可信入口，不要 read 脚本、其凭证或入口所在目录的其他文件；本地副本与 workspace 中的同名 bi_query.py 均不受信任。",
    ...entries.map(([businessLine, label]) => `- ${label}（${businessLine}）：python3 "${trustedDataScripts[businessLine]}" "SELECT ..."`),
    "按问题所属业务线选择对应入口，不得混用；没有对应业务线入口时如实说明缺配置。",
    "查数入口单次最多返回 100 行：明细、导出、清单类请求超过 100 行时，不要承诺整表导出，也不要在没写出文件时声明交付；如实说明只能核对样本或汇总，整表建议走 BI 导出或找虎老师。",
  ];
}

/** @param {string} question @param {"initial"|"deepen"} phase */
function buildHistoryPrompt(question, phase) {
  if (phase === "initial") {
    return [
      "[知识任务路由：历史事件]",
      "先读共享时间线（仅限明确共享的来源）定位时间和相关事项，再按需读取当时记录与决策资料；保留 source_time，不用当前规则倒推当时情况。",
    ];
  }
  const lines = [
    `原始问题：${question}`,
    "这是历史事件任务。先确认已读取共享时间线；若尚未读取就先定位，再只继续读取明确共享的当时记录与相关决策资料，核对事情发生的时间和原因。不要用当前资料替代当时记录；缺少时间线、当时记录或决策依据时明确说出缺口。",
  ];
  if (needsCurrentProgress(question)) {
    lines.push(
      "问题还追问当前进展：另读最新共享项目资料，优先 source_time 最新且 validity=current、明确拍板的记录；history 或其他历史资料只回答当时，不能覆盖当前。新旧资料冲突且无法消解时，必须在答复中说明冲突。",
    );
  }
  return lines;
}

/** @param {string} question @param {"initial"|"deepen"} phase */
function buildProgressPrompt(question, phase) {
  if (phase === "initial") {
    return [
      "[知识任务路由：当前进展]",
      "只从明确共享的项目资料中选择最新进展：结合 source_time 与 validity=current 判断有效版本，history 和早期讨论只能作背景，不能当成现状；无法确认最新时间或拍板结论时明确说明。",
    ];
  }
  return [
    `原始问题：${question}`,
    "这是当前进展任务。只读明确共享且与问题相关的项目资料，按 source_time 和 validity=current 选择最新有效记录。不要用 history 或早期讨论冒充现状；无法确认最新时间、拍板结论或资料相互冲突时明确说明。",
  ];
}

/**
 * 合并实际读取记录，保留来源、时间和每次读取的深度。
 *
 * @param {Array<LoadedResource>} target
 * @param {Array<LoadedResource>|undefined} incoming
 */
function mergeLoadedResources(target, incoming) {
  for (const resource of incoming ?? []) {
    const key = `${resource.source}\0${resource.path}\0${resource.depth}`;
    if (target.some((existing) => `${existing.source}\0${existing.path}\0${existing.depth}` === key)) continue;
    target.push({ ...resource });
  }
}

/**
 * 内容不足时，在同一 agent 会话继续读取当前任务需要的资源。
 * 这是资料深化，不是 Guard 打回，因此不占用 maxRounds。
 *
 * @param {(options: any) => Promise<any>} runAgent
 * @param {any} options
 * @param {{question: string, attachedFiles?: boolean, task: "concept"|"data"|"history"|"progress", catalog?: string, catalogEntries?: Array<LoadedResource>, dataPlaybook?: boolean, trustedDataScripts?: Record<string, string>, loadedResources: Array<LoadedResource>, executionApprovals: Array<any>}} context
 */
async function runWithProgressiveDepth(
  runAgent,
  options,
  { question, attachedFiles = false, task, catalog, catalogEntries = [], dataPlaybook, trustedDataScripts, loadedResources, executionApprovals },
) {
  const first = await runWithStallRetry(runAgent, options);
  for (const attempt of first.attempts) {
    mergeLoadedResources(loadedResources, attempt.loadedResources);
    executionApprovals.push(...(attempt.executionApprovals ?? []));
  }
  if (!catalog || options.isRework || first.turn.failed || first.turn.timedOut || first.turn.stalled) return first;

  const dataTask = task === "data";
  const historyTask = task === "history";
  const progressTask = task === "progress";
  const rawNeeded =
    !dataTask &&
    !historyTask &&
    !progressTask &&
    first.turn.contextInsufficient &&
    !loadedResources.some((resource) => resource.depth === "raw");
  const playbookNeeded =
    dataPlaybook &&
    dataTask &&
    first.turn.contextInsufficient &&
    !loadedResources.some((resource) => resource.depth === "playbook");
  // 同事随消息附了本地文件时，主回答可能完全来自附件本身，不强行要求补齐知识库/BI 证据链
  const dataEvidenceNeeded =
    !attachedFiles &&
    dataTask &&
    !deliverableDataEvidence(
      getMissingDataEvidence(loadedResources, question, Boolean(first.turn.biTouched)),
      Boolean(first.turn.biTouched),
    );
  const historyEvidenceNeeded =
    !attachedFiles && historyTask && getMissingHistoryEvidence(loadedResources, question, catalogEntries).length > 0;
  const progressEvidenceNeeded =
    !attachedFiles && progressTask && !hasCurrentProjectEvidence(loadedResources, catalogEntries);
  if (
    !rawNeeded &&
    !playbookNeeded &&
    !((dataTask || historyTask || progressTask) && first.turn.contextInsufficient) &&
    !dataEvidenceNeeded &&
    !historyEvidenceNeeded &&
    !progressEvidenceNeeded
  ) {
    return first;
  }

  const instructions = dataTask
    ? buildDataPrompt(question, "metrics")
    : historyTask
      ? buildHistoryPrompt(question, "deepen")
      : progressTask
        ? buildProgressPrompt(question, "deepen")
        : [`原始问题：${question}`];
  if (rawNeeded) {
    instructions.push(
      "当前概念页或摘要不足以可靠回答具体规则。请只继续读取目录中与本问题相关的 raw 原始资料（优先概念页列出的 raw_source），保留资料的来源和时间。",
    );
  }
  instructions.push("不要读取无关资料；资源仍不足时明确说缺少哪部分。完成后给出完整答复。");

  const second = await runWithStallRetry(runAgent, { ...options, prompt: instructions.join("\n") });
  for (const attempt of second.attempts) {
    mergeLoadedResources(loadedResources, attempt.loadedResources);
    executionApprovals.push(...(attempt.executionApprovals ?? []));
  }
  const sharedMissing = !attachedFiles && historyTask
    ? getMissingHistoryEvidence(loadedResources, question, catalogEntries)
    : !attachedFiles && progressTask && !hasCurrentProjectEvidence(loadedResources, catalogEntries)
      ? ["最新且明确有效的共享项目资料"]
      : [];
  const secondMissing = getMissingDataEvidence(
    loadedResources,
    question,
    Boolean(first.turn.biTouched || second.turn.biTouched),
  );
  const dataNeedsThird =
    dataTask &&
    (second.turn.contextInsufficient ||
      (!attachedFiles &&
        !deliverableDataEvidence(secondMissing, Boolean(first.turn.biTouched || second.turn.biTouched))));
  if (!dataTask || !dataNeedsThird || second.turn.failed || second.turn.timedOut || second.turn.stalled) {
    return {
      turn: {
        ...second.turn,
        text:
          (second.turn.contextInsufficient || sharedMissing.length > 0) && (historyTask || progressTask)
            ? buildSharedInsufficientText(task, second.turn.text, sharedMissing)
            : second.turn.text,
        biTouched: Boolean(first.turn.biTouched || second.turn.biTouched),
      },
      retries: first.retries + second.retries,
    };
  }

  const third = await runWithStallRetry(runAgent, {
    ...options,
    prompt: buildDataPrompt(question, "sql").join("\n"),
  });
  for (const attempt of third.attempts) {
    mergeLoadedResources(loadedResources, attempt.loadedResources);
    executionApprovals.push(...(attempt.executionApprovals ?? []));
  }
  const dataMissing = getMissingDataEvidence(
    loadedResources,
    question,
    Boolean(first.turn.biTouched || second.turn.biTouched || third.turn.biTouched),
  );
  const shouldBuildDataInsufficient =
    third.turn.contextInsufficient ||
    (!attachedFiles &&
      !deliverableDataEvidence(dataMissing, Boolean(first.turn.biTouched || second.turn.biTouched || third.turn.biTouched)));
  return {
    turn: {
      ...third.turn,
      text: shouldBuildDataInsufficient
        ? buildDataInsufficientText(dataMissing, question, trustedDataScripts)
        : third.turn.text,
      biTouched: Boolean(first.turn.biTouched || second.turn.biTouched || third.turn.biTouched),
    },
    retries: first.retries + second.retries + third.retries,
  };
}

/** @param {LoadedResource} resource */
function isCurrentSharedProject(resource) {
  return (
    (resource.resourceType ?? resource.depth) === "project" &&
    resource.scope === "shared" &&
    resource.validity === "current" &&
    Boolean(resource.sourceTime)
  );
}

/** @param {Array<LoadedResource>} resources @param {Array<LoadedResource>} catalogEntries */
function hasCurrentProjectEvidence(resources, catalogEntries) {
  const currentProjects = (/** @type {Array<LoadedResource>} */ candidates, /** @type {string} */ group) =>
    candidates.filter((resource) => isCurrentSharedProject(resource) && dirname(resource.path) === group);
  return resources.some((resource) => {
    if (!isCurrentSharedProject(resource)) return false;
    const group = dirname(resource.path);
    const catalogProjects = currentProjects(catalogEntries, group);
    const candidates = catalogProjects.length > 0 ? catalogProjects : currentProjects(resources, group);
    const latestTime = candidates.reduce((latest, candidate) =>
      String(candidate.sourceTime).localeCompare(latest) > 0 ? String(candidate.sourceTime) : latest, "");
    return resource.sourceTime === latestTime;
  });
}

/** @param {Array<LoadedResource>} resources @param {string} question @param {Array<LoadedResource>} catalogEntries */
function getMissingHistoryEvidence(resources, question, catalogEntries) {
  const hasShared = (/** @type {string[]} */ types) =>
    resources.some(
      (resource) => types.includes(resource.resourceType ?? resource.depth) && resource.scope === "shared",
    );
  const missing = [];
  if (!hasShared(["timeline"])) missing.push("共享时间线");
  if (!hasShared(["record"])) missing.push("当时记录");
  if (needsCurrentProgress(question) && !hasCurrentProjectEvidence(resources, catalogEntries)) {
    missing.push("最新且明确有效的共享项目资料");
  }
  return missing;
}

/** @param {"history"|"progress"} task @param {string} detail @param {string[]} missing */
function buildSharedInsufficientText(task, detail, missing) {
  const safeDetail = /冲突|缺少|不足|无法|不能确认|未提供/.test(detail) ? `\n${detail}` : "";
  const base =
    task === "history"
      ? "现有共享资料不足或存在未消解冲突，没法可靠还原当时情况。请补充对应时间的共享时间线、当时记录或明确拍板的决策资料。"
      : "现有共享项目资料不足或存在未消解冲突，没法可靠确认当前进展。请补充最新且明确拍板的共享项目资料与生效时间。";
  return `${base}${missing.length > 0 ? `\n缺少：${missing.join("、")}。` : ""}${safeDetail}`;
}

/**
 * 查数证据由编排层验收，不依赖模型自报不足。口径题需要经验和指标；具体数字、
 * 字段或 SQL 任务还需要 SQL 参考和表文档。
 *
 * 两个收敛边界：
 * - 同事直接给 SQL 执行属于通道执行任务，没有业务口径问题，唯一要求是本轮真的
 *   执行过可信查询；
 * - 其余查数任务里，经验层只用于校准口径。当指标卡、已验证 SQL 与表文档都已读、
 *   且本轮可信查询真的执行过时，缺经验一项不再否决已经过执行验证的答复。
 *
 * @param {Array<LoadedResource>} resources
 * @param {string} question
 * @param {boolean} biTouched
 */
function getMissingDataEvidence(resources, question, biTouched) {
  if (isExplicitSqlExecution(question)) {
    return biTouched ? [] : ["本轮只读 BI 查询验证"];
  }
  const has = (/** @type {string} */ type) =>
    resources.some((resource) => (resource.resourceType ?? resource.depth) === type);
  const missing = [
    ...(!has("experience") ? ["相关历史经验"] : []),
    ...(!has("metrics") ? ["对应指标卡"] : []),
  ];
  const actualDataQuery = isActualDataQuery(question);
  const needsSqlAndTable = actualDataQuery || /SQL|表文档|字段|JOIN|关联/i.test(question);
  if (needsSqlAndTable) {
    if (!resources.some((resource) => (resource.resourceType ?? resource.depth) === "sql" && resource.verification === "verified")) {
      missing.push("已验证 SQL");
    }
    if (!has("table")) missing.push("相关表文档");
  }
  if (actualDataQuery && !biTouched) missing.push("本轮只读 BI 查询验证");
  return missing;
}

/**
 * 当前缺口是否已经可以交付：要么证据链齐备，要么口径证据齐备且本轮可信查询
 * 真的执行过、只差校准用的经验层——执行结果就是比经验更强的验证。
 *
 * @param {string[]} missing
 * @param {boolean} biTouched
 */
function deliverableDataEvidence(missing, biTouched) {
  return missing.length === 0 || (biTouched && missing.every((item) => item === "相关历史经验"));
}

/** @param {string} question */
function withoutNegatedDataRequests(question) {
  // “不得不查”里的最后一个“不”不是否定请求，不能从双否定短语内部删除。
  return question.replace(/(?<!不得)(?:不用|无需|不要|不|别)\s*(?:再\s*)?(?:查数|查一下|查查|查询|统计|查)/g, "");
}

/** @param {string} question */
function isExplicitSqlExecution(question) {
  // 同事明确给出要执行的 SQL（“执行 SELECT …”“跑一下这条 SQL”或直接粘贴
  // SELECT … FROM 语句）：这是通道执行任务，不走业务口径证据链。
  return (
    /(?:执行|运行|跑(?:一下|一?次)?)\s*(?:这(?:条|个|段)|以下|下面|上述)?\s*(?:SQL|SELECT|语句)/i.test(question) ||
    /\bSELECT\b[^？?\n]{0,300}\bFROM\b/i.test(question)
  );
}

/** @param {string} question */
function isActualDataQuery(question) {
  const effectiveQuestion = withoutNegatedDataRequests(question);
  const asksQuantity = /多少|几个|几家/.test(effectiveQuestion);
  if (/口径|定义|区别|怎么算|如何计算|是什么|什么意思/.test(effectiveQuestion) && !asksQuantity) return false;
  return (
    asksQuantity ||
    /查数|查一下|查查|查询|统计|生产数据/.test(effectiveQuestion) ||
    (/(?:现在|目前|当前|截至|本月|今年|今天|\d+月)/.test(effectiveQuestion) &&
      /总数|数量|签约量|预约量|出租率|退租率|续约率|空置率|转化率/.test(effectiveQuestion))
  );
}

/** @param {string[]} missing @param {string} question @param {Record<string, string>|undefined} trustedDataScripts */
function buildDataInsufficientText(missing, question, trustedDataScripts) {
  const normalizedQuestion = question.toLowerCase();
  const businessLine = TRUSTED_DATA_BUSINESS_LINES.find(
    ([key, label]) => normalizedQuestion.includes(key) || question.includes(label),
  )?.[0];
  const hasTrustedDataScript = businessLine
    ? Boolean(trustedDataScripts?.[businessLine])
    : Object.values(trustedDataScripts ?? {}).some(Boolean);
  if (
    trustedDataScripts &&
    isActualDataQuery(question) &&
    missing.includes("本轮只读 BI 查询验证") &&
    !hasTrustedDataScript
  ) {
    return "当前实例尚未配置该业务线的可信 BI 执行入口，没法可靠确认这个实时数据。请由实例维护者使用公开的 instance configure-bi 命令配置后再查。";
  }
  return `现有共享资料不足，没法可靠确认这个数据。缺少：${missing.join("、") || "可核对的字段关联或统计范围"}。请补充对应共享资料或明确统计范围。`;
}

/**
 * @param {string} question
 * @param {Array<any>|undefined} skills
 * @param {"concept"|"data"|"history"|"progress"} knowledgeTask
 */
function selectSkill(question, skills = [], knowledgeTask) {
  const normalized = question.toLowerCase();
  const named = longestSkillMatches(normalized, skills, (skill) => [skill.name]);
  if (named.length > 0) return named.length === 1 ? named[0] : undefined;

  const triggered = longestSkillMatches(normalized, skills, (skill) => skill.triggers ?? []);
  if (triggered.length > 0) return triggered.length === 1 ? triggered[0] : undefined;

  const related = skills
    .map((skill) => ({ skill, score: scoreSkillMetadata(normalized, skill) }))
    .filter((candidate) => candidate.score > 0);
  if (related.length > 0) {
    const bestScore = Math.max(...related.map((candidate) => candidate.score));
    const best = related.filter((candidate) => candidate.score === bestScore);
    return best.length === 1 ? best[0].skill : undefined;
  }

  const taskMatches = skills.filter((skill) => skill.tasks?.includes(knowledgeTask));
  return taskMatches.length === 1 ? taskMatches[0] : undefined;
}

/**
 * 名称与触发词先按完整匹配筛选，再只保留最长、最具体的一批候选。
 *
 * @param {string} question
 * @param {Array<any>} skills
 * @param {(skill: any) => Array<any>} getTerms
 */
function longestSkillMatches(question, skills, getTerms) {
  const matches = skills.flatMap((skill) => {
    const length = getTerms(skill).reduce((longest, value) => {
      const term = String(value ?? "").trim().toLowerCase();
      return term && includesCompleteTerm(question, term) ? Math.max(longest, term.length) : longest;
    }, 0);
    return length > 0 ? [{ skill, length }] : [];
  });
  const longest = Math.max(0, ...matches.map((match) => match.length));
  return matches.filter((match) => match.length === longest).map((match) => match.skill);
}

/**
 * ASCII 词不能在更长单词内部命中；中文词组按完整 substring 参与最长比较。
 *
 * @param {string} question
 * @param {string} term
 */
function includesCompleteTerm(question, term) {
  let offset = 0;
  while (offset <= question.length - term.length) {
    const index = question.indexOf(term, offset);
    if (index < 0) return false;
    const before = question[index - 1] ?? "";
    const after = question[index + term.length] ?? "";
    const crossesLeftBoundary = /^[a-z0-9_]/.test(term) && /[a-z0-9_]/.test(before);
    const crossesRightBoundary = /[a-z0-9_]$/.test(term) && /[a-z0-9_]/.test(after);
    if (!crossesLeftBoundary && !crossesRightBoundary) return true;
    offset = index + 1;
  }
  return false;
}

/**
 * 标准 Skill 没有自定义 triggers/tasks 时，用描述与能力中的完整短语或关键英文术语匹配。
 * 同分候选不按目录顺序猜测，避免把无关 Skill 注入审批链。
 *
 * @param {string} question
 * @param {any} skill
 */
function scoreSkillMetadata(question, skill) {
  const stopWords = new Set([
    "a", "an", "and", "are", "ask", "asks", "can", "create", "creating", "current", "for", "from",
    "generate", "generating", "into", "make", "making", "need", "needs", "not", "only", "skill", "skills",
    "support", "supports", "task", "tasks", "that", "the", "this", "to", "tool", "tools", "use", "used",
    "user", "users", "using", "want", "wants", "when", "with", "you", "your",
  ]);
  const matched = new Set();
  for (const value of [skill.description, skill.capabilities]) {
    const text = String(value ?? "").toLowerCase();
    for (const phrase of text.split(/[\n,，;；、.!?！？]+/)) {
      const normalized = phrase.trim();
      if (normalized.length >= 2 && includesCompleteTerm(question, normalized)) matched.add(normalized);
    }
    for (const word of text.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
      if (!stopWords.has(word) && includesCompleteTerm(question, word)) matched.add(word);
    }
  }
  return [...matched].reduce((score, term) => score + term.length, 0);
}

/** @param {string} question */
function classifyKnowledgeTask(question) {
  if (needsDataPlaybook(question)) return "data";
  if (/历史|当时|之前|以前|过去|曾经|原先|来龙去脉|决策原因|为什么(?:改|调整|决定)/.test(question)) return "history";
  if (needsCurrentProgress(question)) return "progress";
  return "concept";
}

/** @param {string} question */
function needsCurrentProgress(question) {
  if (/状态(?:有哪些|列表|枚举)|(?:有哪些|哪些)[^？\n]*状态/.test(question)) return false;
  return (
    /进展如何|项目进展|最新进展|当前进展/.test(question) ||
    (/当前|目前|现在|最新/.test(question) &&
      /项目|需求|功能|开发|上线|同步|联调|排期|进展|完成|推进|关闭|下线|发布|迭代|版本/.test(question))
  );
}

/** @param {string} question */
function needsDataPlaybook(question) {
  if (isExplicitSqlExecution(question)) return true;
  const effectiveQuestion = withoutNegatedDataRequests(question);
  if (isBulkExportRequest(effectiveQuestion)) return true;
  if (
    /(?:多少|几)(?:种|类)|哪些(?:类型|种类)/.test(effectiveQuestion) &&
    !/生产数据|查数|查一下|查查|查询|统计|口径|SQL|现在|目前|当前|总数|数量|几个|几家/i.test(effectiveQuestion)
  ) {
    return false;
  }
  return /生产数据|查数|查一下|查查|查询|统计|口径|SQL|签约量|预约量|出租率|退租率|续约率|空置率|转化率|总数|数量|机构数|多少|几个|几家/i.test(
    effectiveQuestion,
  );
}

/**
 * 导出、要明细、要清单：这类请求同样需要查数手册和可信 BI 入口。
 * 只认「导出动作 + 数据对象」，避免把「导出按钮在哪」这类界面问题当成查数。
 *
 * @param {string} question
 */
function isBulkExportRequest(question) {
  if (/在哪|哪里|按钮|入口|权限/.test(question)) return false;
  const exportVerb = /导出|导一份|导个|要一份|给我一份|来一份|出一份/;
  const dataObject = /房源|房间|楼栋|门店|机构|合同|线索|明细|清单|名单|表格|Excel|xlsx|csv/i;
  return exportVerb.test(question) && dataObject.test(question);
}

/**
 * 卡住时自动重试一次。
 *
 * 事件流静默多半是模型通道间歇停摆，而不是这道题真的答不了：换个时刻再跑一次往往就通了。
 * 只重试一次，且沿用同一个会话 —— 第一次已经查到的东西还在上下文里。
 *
 * @param {(options: any) => Promise<any>} runAgent
 * @param {any} options
 */
async function runWithStallRetry(runAgent, options) {
  const first = await runAgent(options);
  if (!first.stalled) return { turn: first, retries: 0, attempts: [first] };
  const second = await runAgent(options);
  return {
    turn: { ...second, biTouched: Boolean(first.biTouched || second.biTouched) },
    retries: 1,
    attempts: [first, second],
  };
}

/**
 * 打回重写时给 agent 的指令。只给理由，不给它看被判定的原文，
 * 避免它直接把敏感片段「换个说法」照抄一遍。
 *
 * @param {string} reason
 * @returns {string}
 */
function buildReworkPrompt(reason) {
  return [
    "你上一条答复未通过隐私检查。",
    `原因：${reason}`,
    "请重新组织答复：去掉所有具体个人信息（手机号、身份证号、姓名与联系方式组合、逐条明细），只保留结论、统计口径和业务解释。",
    "直接输出完整的重写答复，不要解释你改了什么。",
  ].join("\n");
}
