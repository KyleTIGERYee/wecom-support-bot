/**
 * 只读取 evolution 经验层，供 agent 在查数前调用。
 *
 * 为什么不直接用 wiki 自带的 preflight 脚本：preflight 会创建 run 目录、
 * 改写 state/进化状态.json，那是维护知识库的动作。问答场景只需要"读经验"，
 * 不能污染被多个 agent 共用的 wiki 资产。
 *
 * 读三层：
 *   1. common/通用判断标准.md 与 personal/个人判断标准.md —— 每次必读的硬底线
 *   2. personal/纠偏备忘录.md —— 用户纠偏与错误归因
 *   3. 经验索引 jsonl —— 按关键词打分检索候选经验
 *
 * 用法：
 *   node scripts/read-evolution.js <db-wiki 目录> "<检索词>"
 *   node scripts/read-evolution.js /path/to/lzz-db-wiki "机构数量"
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MAX_INDEX_HITS = 5;
const MAX_EXCERPT = 500;

/** 读一个文件，不存在就返回空串。 */
async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** 找到 wiki 根下的 evolution 目录（名字随 wiki 而变，形如 .xxx-db-wiki-evolution）。 */
async function findEvolutionDir(wikiRoot) {
  let entries;
  try {
    entries = await readdir(wikiRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const dir = entries.find((entry) => entry.isDirectory() && entry.name.endsWith("-evolution"));
  return dir ? join(wikiRoot, dir.name) : null;
}

/** 从「## 当前标准」之后取正文，去掉模板说明。 */
function extractStandards(markdown) {
  const marker = "## 当前标准";
  const index = markdown.indexOf(marker);
  const body = index === -1 ? markdown : markdown.slice(index + marker.length);
  return body
    .split("\n")
    .filter((line) => !line.startsWith(">") && line.trim() !== "")
    .join("\n")
    .trim();
}

/** 按关键词给一条经验打分。 */
function scoreEntry(entry, terms) {
  const haystack = `${entry.key ?? ""} ${entry.candidate ?? ""} ${entry.artifact ?? ""}`.toLowerCase();
  return terms.reduce((sum, term) => (haystack.includes(term.toLowerCase()) ? sum + 10 : sum), 0);
}

/**
 * @param {string} wikiRoot
 * @param {string} query
 * @returns {Promise<string>} 可直接拼进提示词的纯文本
 */
export async function readEvolution(wikiRoot, query) {
  const dir = await findEvolutionDir(wikiRoot);
  if (!dir) return "";

  const sections = [];

  for (const layer of ["common", "personal"]) {
    const standardsPath = join(dir, layer, layer === "common" ? "通用判断标准.md" : "个人判断标准.md");
    if (!existsSync(standardsPath)) continue;
    const content = extractStandards(await readIfExists(standardsPath));
    if (content && content !== "暂无。") {
      sections.push(`【${layer === "common" ? "通用" : "个人"}判断标准（必须遵守）】\n${content}`);
    }
  }

  const memoPath = join(dir, "personal", "纠偏备忘录.md");
  if (existsSync(memoPath)) {
    const memo = extractStandards(await readIfExists(memoPath));
    // 模板占位符（只有标题或"暂无"）不算有效内容
    const meaningful = memo
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.trim() !== "" && line.trim() !== "暂无。")
      .join("\n")
      .trim();
    if (meaningful) sections.push(`【历史纠偏记录】\n${meaningful}`);
  }

  // 经验索引：按关键词取最相关的几条
  const terms = (query ?? "")
    .split(/[\s,，、]+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length > 0) {
    const hits = [];
    for (const layer of ["common", "personal"]) {
      const indexPath = join(dir, layer, layer === "common" ? "通用经验索引.jsonl" : "个人经验索引.jsonl");
      if (!existsSync(indexPath)) continue;
      const raw = await readIfExists(indexPath);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          const score = scoreEntry(entry, terms);
          if (score > 0) hits.push({ score, entry });
        } catch {
          // 坏行跳过
        }
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, MAX_INDEX_HITS);
    if (top.length > 0) {
      const lines = top.map(({ score, entry }) => {
        const text = entry.candidate ?? entry.key ?? "";
        return `- （相关度 ${score}）${text.slice(0, MAX_EXCERPT)}`;
      });
      sections.push(`【与「${query}」相关的历史经验】\n${lines.join("\n")}`);
    }
  }

  if (sections.length === 0) return "";
  return sections.join("\n\n");
}

// 作为命令行工具直接调用
if (process.argv[1]?.endsWith("read-evolution.js")) {
  const [wikiRoot, query] = process.argv.slice(2);
  if (!wikiRoot) {
    console.error('用法：node scripts/read-evolution.js <db-wiki 目录> "<检索词>"');
    process.exit(1);
  }
  const output = await readEvolution(wikiRoot, query ?? "");
  process.stdout.write(output || "（暂无经验记录）");
  process.stdout.write("\n");
}
