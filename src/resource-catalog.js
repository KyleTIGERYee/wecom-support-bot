import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const PER_FILE_CATALOG_LIMIT = 1000;

const RESOURCE_PATH = {
  playbook: /data-playbook|查数手册/i,
  experience: /(?:^|\/)(?:\.[^/]*-evolution|evolution|经验)(?:\/|$)/i,
  metrics: /(?:^|\/)metrics(?:\/|$)/i,
  table: /(?:^|\/)tables(?:\/|$)/i,
  sql: /\.sql$|(?:^|\/)queries(?:\/|$)/i,
  timeline: /时间线|(?:^|\/)timeline(?:\.|\/|$)/i,
  record: /(?:^|\/)raw\/(?:收件箱|records?|history)(?:\/|$)|当时记录/i,
  decision: /(?:^|\/)(?:决策|decisions?)(?:\/|$)|决策资料/i,
  project: /(?:^|\/)(?:projects?|项目|项目资料)(?:\/|$)|当前进展|项目进展/i,
  raw: /(?:^|\/)raw(?:\/|$)/i,
};

/**
 * 默认实例的选择目录来自现有配置，不在主提示词中复制固定路径或资源正文。
 *
 * @param {Record<string, string>} roots
 * @param {string} projectDir
 */
export function createDefaultResourceCatalog(roots, projectDir) {
  const knowledgeBase = roots.knowledgeBase;
  const definitions = [
    { key: "ajlyCode", source: "安居乐寓代码", description: "安居乐寓实现逻辑；知识资料不足时按需检索" },
    { key: "lzzCode", source: "乐租租代码", description: "乐租租实现逻辑；知识资料不足时按需检索" },
  ];
  const entries = [];
  if (knowledgeBase) {
    for (const [line, prefix] of [
      ["安居乐寓", "ajly"],
      ["乐租租", "lzz"],
    ]) {
      entries.push(
        {
          source: `${line}业务 Wiki`,
          path: join(knowledgeBase, `业务/${prefix}-wiki`),
          directory: true,
          depth: "catalog",
          sourceTime: null,
          validity: "unmarked",
          rawBase: join(knowledgeBase, `业务/${prefix}-wiki`),
          description: `${line}概念、流程与规则；先检索概念页，必要时再读 raw`,
        },
        {
          source: `${line}数据库 Wiki`,
          path: join(knowledgeBase, `数据库/${prefix}-db-wiki`),
          directory: true,
          depth: "catalog",
          sourceTime: null,
          validity: "unmarked",
          description: `${line}数据口径与只读查询资源；查数时先读查数手册`,
        },
      );
    }
  }
  for (const definition of definitions) {
    const path = roots[definition.key];
    if (path) {
      entries.push({ ...definition, path, directory: true, depth: "catalog", sourceTime: null, validity: "unmarked" });
    }
  }
  entries.push({
    source: "查数手册",
    path: join(projectDir, "prompts/data-playbook.md"),
    directory: false,
    depth: "playbook",
    sourceTime: null,
    validity: "unmarked",
    description: "仅在查数、写 SQL、核对数据口径或需要翻代码时读取",
  });

  return {
    entries,
    skills: [],
    dataPlaybook: true,
    text: [
      "以下目录来自本实例配置，只含选择所需元数据；按业务线选择，不得混用两条业务线的资源。",
      ...entries.map((entry) =>
        [
          `- source: ${entry.source}`,
          `path: ${entry.path}`,
          `depth: ${entry.depth}`,
          `source_time: ${entry.sourceTime}`,
          `validity: ${entry.validity}`,
          `summary: ${entry.description}`,
          ...(entry.rawBase ? [`raw_base: ${entry.rawBase}`] : []),
        ].join(" | "),
      ),
      "Skill 目录：当前未配置可加载 Skills。",
    ].join("\n"),
  };
}

/**
 * 从初始化时复制的本地来源生成选择目录。正文只用于提取 frontmatter 元数据，不进入目录文本。
 *
 * @param {string} instanceDir
 * @param {Array<{name: string, scope: string, localPath?: string, status: string}>} sources
 * @param {string|null} copiedAt
 */
export async function createLocalResourceCatalog(instanceDir, sources, copiedAt = null) {
  /** @type {Array<any>} */
  const entries = [];
  /** @type {Array<any>} */
  const skills = [];
  /** @type {Array<any>} 每个来源的目录级摘要，供目录文本使用 */
  const sourceSummaries = [];
  for (const source of sources) {
    if (source.status !== "ok" || !source.localPath) continue;
    const root = resolve(instanceDir, source.localPath);
    const files = await listFiles(root);
    /** @type {{name: string, scope: string, root: string, files: number, skills: number, types: Record<string, number>, groups: Map<string, {files: number, types: Record<string, number>, samples: string[]}>}} */
    const summary = { name: source.name, scope: source.scope, root, files: 0, skills: 0, types: {}, groups: new Map() };
    const skillFiles = files.filter((path) => basename(path) === "SKILL.md");
    const skillMetadata = new Map();
    for (const path of skillFiles) {
      const metadata = await readMetadata(path);
      const skillRoot = dirname(path);
      const name = metadata.name ?? basename(skillRoot);
      skillMetadata.set(skillRoot, { ...metadata, name });
    }
    for (const path of files) {
      const skillRoot = [...skillMetadata.keys()]
        .filter((candidate) => path === candidate || path.startsWith(`${candidate}/`))
        .sort((a, b) => b.length - a.length)[0];
      const metadata = await readMetadata(path);
      const owningSkill = skillRoot ? skillMetadata.get(skillRoot) : undefined;
      const sourceTime = metadata.sourceTime ?? owningSkill?.sourceTime ?? null;
      const common = {
        source: source.name,
        scope: source.scope,
        path,
        sourceTime,
        copiedAt,
        validity: metadata.validity ?? owningSkill?.validity ?? inferValidity(path),
      };
      const relativePath = relative(root, path) || basename(path);
      const resourceType = classifyResourceType(path);
      // 目录文本的计数必须包含 Skill 根内的知识文件，否则真实知识库会显示成几十个文件。
      const segments = relativePath.split("/");
      const group = segments.length === 1 ? "." : segments.slice(0, Math.max(1, Math.min(2, segments.length - 1))).join("/");
      summary.files += 1;
      summary.types[resourceType] = (summary.types[resourceType] ?? 0) + 1;
      const bucket = summary.groups.get(group) ?? { files: 0, types: {}, samples: [] };
      bucket.files += 1;
      bucket.types[resourceType] = (bucket.types[resourceType] ?? 0) + 1;
      // 样例只取可读的知识文件，跳过 .gitignore/.obsidian 之类，避免把模型引到无用路径。
      const hidden = relativePath.split("/").some((segment) => segment.startsWith("."));
      const sampleWorthy = ["concept", "metrics", "table", "sql", "experience", "playbook", "timeline", "record", "decision", "project"].includes(resourceType);
      if (!hidden && sampleWorthy && bucket.samples.length < 3) bucket.samples.push(relativePath);
      summary.groups.set(group, bucket);
      if (skillRoot) {
        const skillName = owningSkill.name;
        const isBody = path === join(skillRoot, "SKILL.md");
        const skillResourceType = isBody ? "skill" : classifySkillResource(skillRoot, path);
        entries.push({
          ...common,
          relativePath,
          depth: skillResourceType,
          // Skill 正文必须保持 resourceType=skill，loadedSkills 与技能检查都依赖它；
          // 目录摘要里的类型计数仍然按知识类型统计。
          resourceType: isBody ? "skill" : resourceType,
          skillResourceType,
          skillName,
          summary: metadata.summary || owningSkill.summary,
          verification: metadata.verification,
        });
        if (isBody) {
          skills.push({
            ...common,
            name: skillName,
            description: metadata.summary,
            capabilities: metadata.capabilities ?? "未声明额外能力；命中后按需读取正文",
            triggers: metadata.triggers,
            tasks: metadata.tasks,
          });
        }
        continue;
      }
      entries.push({
        ...common,
        relativePath,
        depth: classifyResourceDepth(path),
        resourceType,
        summary: metadata.summary,
        verification: metadata.verification,
        rawSources: metadata.rawSources,
        rawBase: rawBaseFor(root, path),
      });
    }
    summary.skills = skills.filter((skill) => skill.source === source.name).length;
    sourceSummaries.push(summary);
  }
  if (entries.length === 0) throw new Error("实例没有可读取的本地上下文来源");

  const listed = entries.filter((entry) => !entry.skillName);
  // 小来源逐文件列出，便于直接定位；文件多时只给目录摘要。逐文件清单在真实知识库上
  // 会到几 MB，既超出命令行参数上限，也塞不进模型上下文。
  const useDirectorySummary = listed.length > PER_FILE_CATALOG_LIMIT;

  return {
    entries,
    skills,
    dataPlaybook: entries.some((entry) => entry.depth === "playbook"),
    text: [
      "以下来源均为初始化时选择的本地副本；只能读取目录中的路径。source_time 是资料自身时间，未知为 null；copied_at 是实例复制时间。",
      "validity=history 表示历史资料；validity=current 表示明确标记的当前口径；unmarked 不得在历史冲突时直接当作最新口径。",
      ...(useDirectorySummary
        ? [
            "目录只给到二级摘要（来源 → 目录 → 文件数与类型计数）。需要具体文件时先用只读命令探索，例如 `ls <root>/数据库/<db-wiki>/metrics`、`find <root> -name '*.md' | head`、`grep -rl 关键词 <root>`，再 read 命中的文件；不要凭摘要编造路径。",
            ...sourceSummaries.map(formatSourceSummary),
          ]
        : listed.map(formatEntry)),
      "Skill 目录只含名称、触发描述、必要能力摘要与正文入口；未命中时不读取正文，命中后按需读取引用资源。",
      ...(skills.length > 0 ? skills.map(formatSkillEntry) : ["Skill 目录：当前未配置可加载 Skills。"]),
    ].join("\n"),
  };
}

/** @param {{name: string, scope: string, root: string, files: number, skills: number, types: Record<string, number>, groups: Map<string, {files: number, types: Record<string, number>, samples?: string[]}>}} summary */
function formatSourceSummary(summary) {
  const counts = Object.entries(summary.types)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  const groups = [...summary.groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([group, bucket]) => {
      const detail = Object.entries(bucket.types)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type}=${count}`)
        .join(", ");
      const samples = bucket.samples?.length ? `; 样例: ${bucket.samples.join(", ")}` : "";
      return `  - ${group}/ (${bucket.files} 个文件; ${detail}${samples})`;
    });
  return [
    `- source: ${summary.name} | scope: ${summary.scope} | root: ${summary.root} | files: ${summary.files} | skills: ${summary.skills} | types: ${counts || "none"}`,
    ...groups,
  ].join("\n");
}

/** @param {any} skill */
function formatSkillEntry(skill) {
  return [
    `- skill: ${skill.name}`,
    `path: ${skill.path}`,
    `trigger: ${skill.description}`,
    `capabilities: ${Array.isArray(skill.capabilities) ? skill.capabilities.join("、") : skill.capabilities}`,
    `triggers: ${skill.triggers.join("、")}`,
    `tasks: ${skill.tasks.join("、")}`,
    `source_time: ${skill.sourceTime}`,
    `copied_at: ${skill.copiedAt}`,
  ].join(" | ");
}

/** @param {string} skillRoot @param {string} path */
function classifySkillResource(skillRoot, path) {
  const relativePath = relative(skillRoot, path).replaceAll("\\", "/");
  if (relativePath.startsWith("scripts/")) return "skill-script";
  if (/(?:^|\/)(?:templates?|模板)\//i.test(relativePath)) return "skill-template";
  return "skill-reference";
}

/** @param {any} entry */
function formatEntry(entry) {
  const fields = [
    `source: ${entry.source}`,
    `scope: ${entry.scope}`,
    `path: ${entry.path}`,
    `depth: ${entry.depth}`,
    `resource_type: ${entry.resourceType}`,
    `source_time: ${entry.sourceTime}`,
    `copied_at: ${entry.copiedAt}`,
    `validity: ${entry.validity}`,
  ];
  if (entry.verification) fields.push(`verification: ${entry.verification}`);
  if (entry.summary) fields.push(`summary: ${entry.summary}`);
  if (entry.rawSources.length > 0) {
    fields.push(`raw_source: ${entry.rawSources.join(", ")}`, `raw_base: ${entry.rawBase}`);
  }
  return `- ${fields.join(" | ")}`;
}

/** @param {string} path */
async function readMetadata(path) {
  const empty = { name: undefined, summary: "", capabilities: undefined, sourceTime: undefined, validity: undefined, verification: undefined, rawSources: [], triggers: [], tasks: [] };
  if (/\.sql$/i.test(path)) {
    const content = await readHead(path);
    const header = content.split("\n").slice(0, 12).join("\n");
    return {
      ...empty,
      verification: parseSqlVerification(header),
    };
  }
  if (!/\.(?:md|markdown|txt)$/i.test(path)) return empty;
  const content = await readHead(path);
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  if (!frontmatter) return empty;

  const metadata = parseFrontmatter(frontmatter);
  const value = (/** @type {string[]} */ names) => {
    for (const name of names) {
      if (metadata.has(name)) return metadata.get(name);
    }
    return undefined;
  };
  const scalar = (/** @type {string[]} */ names) => {
    const found = value(names);
    return typeof found === "string" && found ? found : undefined;
  };
  const list = (/** @type {string[]} */ names) => {
    const found = value(names);
    const values = Array.isArray(found) ? found : typeof found === "string" ? found.split(/[,，;；]/) : [];
    return values.map((item) => String(item).trim()).filter(Boolean);
  };
  const status = scalar(["validity", "status"])?.toLowerCase();
  const capabilities = value(["capabilities", "capability"]);
  return {
    name: scalar(["name"]),
    summary: scalar(["summary", "description", "title"]) ?? "",
    capabilities: Array.isArray(capabilities)
      ? capabilities.map((item) => String(item).trim()).filter(Boolean)
      : scalar(["capabilities", "capability"]),
    triggers: list(["triggers", "trigger"]),
    tasks: list(["tasks", "task"]),
    sourceTime: scalar([
      "source_time",
      "source-date",
      "updated",
      "updated_at",
      "update_time",
      "last_updated",
      "date",
      "created",
      "created_at",
    ]),
    validity: /history|archived|superseded|历史|归档|作废/.test(status ?? "")
      ? "history"
      : /current|effective|active|当前|有效/.test(status ?? "")
        ? "current"
        : undefined,
    rawSources: list(["raw_source"]),
    verification: undefined,
  };
}

/**
 * 当前公开元数据只需要顶层标量、folded/literal 块与缩进列表。
 * 这是刻意受限的 YAML 子集，不执行标签、锚点或 Skill 中的任何代码。
 *
 * @param {string} frontmatter
 */
function parseFrontmatter(frontmatter) {
  const values = new Map();
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([a-z_][\w-]*):(?:[ \t]*(.*))?$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const inline = match[2] ?? "";
    const block = inline.match(/^([>|])([+-])?$/);
    if (block) {
      const blockLines = [];
      while (index + 1 < lines.length && (/^[ \t]/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
        blockLines.push(lines[index + 1]);
        index += 1;
      }
      values.set(key, parseBlockScalar(blockLines, block[1], block[2]));
      continue;
    }
    if (!inline) {
      const items = [];
      while (index + 1 < lines.length && /^\s+-\s*/.test(lines[index + 1])) {
        items.push(parseInlineScalar(lines[index + 1].replace(/^\s+-\s*/, "")));
        index += 1;
      }
      values.set(key, items.length > 0 ? items : "");
      continue;
    }
    values.set(key, parseInlineScalar(inline));
  }
  return values;
}

/** @param {string} value */
function parseInlineScalar(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === '"' || quote === "'") && trimmed.at(-1) === quote ? trimmed.slice(1, -1) : trimmed;
}

/** @param {string[]} lines @param {string} style @param {string|undefined} chomping */
function parseBlockScalar(lines, style, chomping) {
  const indentation = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)?.[0].length ?? 0));
  const content = lines.map((line) => line.trim() ? line.slice(Number.isFinite(indentation) ? indentation : 0) : "");
  let body = style === "|" ? content.join("\n") : "";
  if (style === ">") {
    body = content.reduce((folded, line, index) => {
      if (index === 0) return line;
      return `${folded}${line && content[index - 1] ? " " : "\n"}${line}`;
    }, "");
  }
  if (chomping === "-") return body.replace(/\n+$/, "");
  if (chomping === "+") return `${body}\n`;
  return `${body.replace(/\n+$/, "")}\n`;
}

/** @param {string} header */
function parseSqlVerification(header) {
  if (/❌|已知问题|known[ -]issue/i.test(header)) return "known-issue";
  if (/⚠️\s*未验证|未验证|\bnot[\s-]+verified\b|\bunverified\b|\bverified\s*:\s*(?:false|no|0)\b/i.test(header)) {
    return "unverified";
  }
  return /✅\s*已验证|\bverified\b/i.test(header) ? "verified" : "unverified";
}

/** @param {string} path */
export function classifyResourceDepth(path) {
  if (RESOURCE_PATH.experience.test(path)) return "experience";
  if (RESOURCE_PATH.timeline.test(path) || RESOURCE_PATH.decision.test(path) || RESOURCE_PATH.project.test(path)) {
    return "document";
  }
  if (RESOURCE_PATH.raw.test(path)) return "raw";
  if (RESOURCE_PATH.playbook.test(path)) return "playbook";
  if (RESOURCE_PATH.metrics.test(path)) return "metrics";
  if (RESOURCE_PATH.table.test(path)) return "table";
  if (RESOURCE_PATH.sql.test(path)) return "sql";
  return "concept";
}

/**
 * 目录和加载记录共用资源类型，避免历史记录、经验和表文档都被笼统当成普通正文。
 *
 * @param {string} path
 */
function classifyResourceType(path) {
  if (RESOURCE_PATH.playbook.test(path)) return "playbook";
  if (RESOURCE_PATH.experience.test(path)) return "experience";
  if (RESOURCE_PATH.metrics.test(path)) return "metrics";
  if (RESOURCE_PATH.table.test(path)) return "table";
  if (RESOURCE_PATH.sql.test(path)) return "sql";
  if (RESOURCE_PATH.timeline.test(path)) return "timeline";
  if (RESOURCE_PATH.record.test(path)) return "record";
  if (RESOURCE_PATH.decision.test(path)) return "decision";
  if (RESOURCE_PATH.project.test(path)) return "project";
  if (RESOURCE_PATH.raw.test(path)) return "raw";
  return "concept";
}

/**
 * 把成功完成的 read 映射回本轮目录，未列入目录的图片等读取不冒充知识资源。
 *
 * @param {string} path
 * @param {Array<any>} catalog
 * @param {string|undefined} readContent
 */
export function findCatalogResource(path, catalog, readContent = undefined) {
  const exact = catalog.find((entry) => entry.path === path);
  const entry =
    exact ??
    catalog
      .filter((candidate) => candidate.directory && path.startsWith(`${candidate.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  if (!entry) return null;
  const resourceType = entry.resourceType ?? classifyResourceType(path);
  const verification =
    entry.verification ?? (resourceType === "sql" && readContent ? parseSqlVerification(readContent) : undefined);
  return {
    source: entry.source,
    path,
    depth: entry.directory ? classifyResourceDepth(path) : entry.depth,
    resourceType,
    ...(Object.hasOwn(entry, "sourceTime") ? { sourceTime: entry.sourceTime } : {}),
    ...(Object.hasOwn(entry, "copiedAt") ? { copiedAt: entry.copiedAt } : {}),
    ...(entry.validity ? { validity: entry.validity } : {}),
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.skillName ? { skillName: entry.skillName } : {}),
    ...(entry.skillResourceType ? { skillResourceType: entry.skillResourceType } : {}),
    ...(verification ? { verification } : {}),
  };
}

/** @param {Array<{depth: string}>} resources */
export function getLoadDepth(resources) {
  /** @type {Record<string, number>} */
  const ranks = { catalog: 0, concept: 1, document: 1, playbook: 2, skill: 2, metrics: 2, experience: 3, table: 3, "skill-reference": 3, "skill-template": 3, sql: 4, "skill-script": 4, raw: 5 };
  let deepest = "catalog";
  for (const resource of resources) {
    if ((ranks[resource.depth] ?? 1) >= (ranks[deepest] ?? 0)) deepest = resource.depth;
  }
  return deepest;
}

/** @param {string} path */
function inferValidity(path) {
  return /(?:^|\/)(?:archive|archived|history|old|归档|历史)(?:\/|$)|(?:历史|旧版|作废)/i.test(path)
    ? "history"
    : "unmarked";
}

/** @param {string} root @param {string} path */
function rawBaseFor(root, path) {
  const marker = `${join("wiki", "概念")}/`;
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.indexOf(`/${marker}`);
  if (index >= 0) return normalized.slice(0, index);
  const infoPath = relative(root, path);
  return infoPath ? root : dirname(path);
}

/** @param {string} path @returns {Promise<string[]>} */
async function listFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

/**
 * 只读文件开头一段。元数据（frontmatter、SQL 校验标记）都在文件头部，
 * 整读大文件会把数 GB 的知识库读进堆内存。
 *
 * @param {string} path
 * @param {number} [bytes]
 * @returns {Promise<string>}
 */
async function readHead(path, bytes = 64 * 1024) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
