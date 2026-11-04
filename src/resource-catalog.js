import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

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
  for (const source of sources) {
    if (source.status !== "ok" || !source.localPath) continue;
    const root = resolve(instanceDir, source.localPath);
    for (const path of await listFiles(root)) {
      const metadata = await readMetadata(path);
      const relativePath = relative(root, path) || basename(path);
      const sourceTime = metadata.sourceTime ?? null;
      entries.push({
        source: source.name,
        scope: source.scope,
        path,
        relativePath,
        depth: classifyResourceDepth(path),
        summary: metadata.summary,
        sourceTime,
        copiedAt,
        validity: metadata.validity ?? inferValidity(path),
        rawSources: metadata.rawSources,
        rawBase: rawBaseFor(root, path),
      });
    }
  }
  if (entries.length === 0) throw new Error("实例没有可读取的本地上下文来源");

  return {
    entries,
    dataPlaybook: entries.some((entry) => entry.depth === "playbook"),
    text: [
      "以下来源均为初始化时选择的本地副本；只能读取目录中的路径。source_time 是资料自身时间，未知为 null；copied_at 是实例复制时间。",
      "validity=history 表示历史资料；validity=current 表示明确标记的当前口径；unmarked 不得在历史冲突时直接当作最新口径。",
      ...entries.map(formatEntry),
    ].join("\n"),
  };
}

/** @param {any} entry */
function formatEntry(entry) {
  const fields = [
    `source: ${entry.source}`,
    `scope: ${entry.scope}`,
    `path: ${entry.path}`,
    `depth: ${entry.depth}`,
    `source_time: ${entry.sourceTime}`,
    `copied_at: ${entry.copiedAt}`,
    `validity: ${entry.validity}`,
  ];
  if (entry.summary) fields.push(`summary: ${entry.summary}`);
  if (entry.rawSources.length > 0) {
    fields.push(`raw_source: ${entry.rawSources.join(", ")}`, `raw_base: ${entry.rawBase}`);
  }
  return `- ${fields.join(" | ")}`;
}

/** @param {string} path */
async function readMetadata(path) {
  const empty = { summary: "", sourceTime: undefined, validity: undefined, rawSources: [] };
  if (!/\.(?:md|markdown|txt)$/i.test(path)) return empty;
  const content = await readFile(path, "utf8");
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  if (!frontmatter) return empty;

  const scalar = (/** @type {string[]} */ names) => {
    for (const name of names) {
      const value = frontmatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im"))?.[1];
      if (value) return value.replace(/^(?:"|')|(?:"|')$/g, "");
    }
    return undefined;
  };
  const rawSources = [];
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^raw_source\s*:\s*$/i.test(lines[index])) continue;
    for (let next = index + 1; next < lines.length && /^\s+-\s+/.test(lines[next]); next += 1) {
      rawSources.push(lines[next].replace(/^\s+-\s+/, "").replace(/^(?:"|')|(?:"|')$/g, ""));
    }
  }
  const status = scalar(["validity", "status"])?.toLowerCase();
  return {
    summary: scalar(["summary", "description", "title"]) ?? "",
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
    rawSources,
  };
}

/** @param {string} path */
export function classifyResourceDepth(path) {
  if (/(?:^|\/)raw(?:\/|$)/i.test(path)) return "raw";
  if (/data-playbook|查数手册/i.test(path)) return "playbook";
  if (/(?:^|\/)metrics(?:\/|$)/i.test(path)) return "metrics";
  if (/(?:^|\/)tables(?:\/|$)/i.test(path)) return "table";
  if (/\.sql$|(?:^|\/)queries(?:\/|$)/i.test(path)) return "sql";
  return "concept";
}

/**
 * 把成功完成的 read 映射回本轮目录，未列入目录的图片等读取不冒充知识资源。
 *
 * @param {string} path
 * @param {Array<any>} catalog
 */
export function findCatalogResource(path, catalog) {
  const exact = catalog.find((entry) => entry.path === path);
  const entry =
    exact ??
    catalog
      .filter((candidate) => candidate.directory && path.startsWith(`${candidate.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  if (!entry) return null;
  return {
    source: entry.source,
    path,
    depth: entry.directory ? classifyResourceDepth(path) : entry.depth,
    ...(Object.hasOwn(entry, "sourceTime") ? { sourceTime: entry.sourceTime } : {}),
    ...(Object.hasOwn(entry, "copiedAt") ? { copiedAt: entry.copiedAt } : {}),
    ...(entry.validity ? { validity: entry.validity } : {}),
    ...(entry.scope ? { scope: entry.scope } : {}),
  };
}

/** @param {Array<{depth: string}>} resources */
export function getLoadDepth(resources) {
  /** @type {Record<string, number>} */
  const ranks = { catalog: 0, concept: 1, document: 1, playbook: 2, metrics: 2, table: 3, sql: 3, raw: 4 };
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
