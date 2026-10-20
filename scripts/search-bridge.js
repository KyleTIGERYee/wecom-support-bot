/**
 * 在 bridge_index.json 里按业务词匹配指标，供 agent 查数前路由。
 *
 * 为什么需要这个：bridge_index.json 有 39KB，整读会灌满上下文；把它 grep
 * 出来又因为含大量结构化字段读不懂。wiki 的 SKILL.md 要求"用 trigger_words
 * 匹配"，但没有提供检索脚本，所以这里补一个只读的。
 *
 * 用法：
 *   node scripts/search-bridge.js <db-wiki 目录> "退租率"
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_HITS = 5;

/** 中文按二元切分，英文按空格切，避免整句匹配不上。 */
function tokenize(query) {
  return (query ?? "")
    .split(/[\s,，、]+/)
    .flatMap((token) => {
      if (/^[\u4e00-\u9fff]{4,}$/.test(token)) {
        const bigrams = [];
        for (let i = 0; i < token.length - 1; i += 1) bigrams.push(token.slice(i, i + 2));
        return [token, ...bigrams];
      }
      return [token];
    })
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * @param {string} wikiRoot
 * @param {string} query
 * @returns {Promise<Array<{id: string, score: number, triggerWords: string[], metricFile: string, relatedQueries: string[]}>>}
 */
export async function searchBridge(wikiRoot, query) {
  const path = join(wikiRoot, "references", "index", "bridge_index.json");
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }

  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const terms = tokenize(query);

  const scored = metrics.map((metric) => {
    const triggers = Array.isArray(metric.trigger_words) ? metric.trigger_words : [];
    const haystack = `${metric.id ?? ""} ${triggers.join(" ")} ${metric.search_query_hint ?? ""}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const lower = term.toLowerCase();
      if ((metric.id ?? "").toLowerCase() === lower) score += 30;
      else if (triggers.some((t) => t.toLowerCase() === lower)) score += 20;
      else if (haystack.includes(lower)) score += 5;
    }
    return { metric, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS)
    .map(({ metric, score }) => ({
      id: metric.id ?? "",
      score,
      triggerWords: Array.isArray(metric.trigger_words) ? metric.trigger_words : [],
      metricFile: metric.metric_file ?? "",
      relatedQueries: Array.isArray(metric.related_queries) ? metric.related_queries : [],
    }));
}

if (process.argv[1]?.endsWith("search-bridge.js")) {
  const [wikiRoot, query] = process.argv.slice(2);
  if (!wikiRoot) {
    console.error('用法：node scripts/search-bridge.js <db-wiki 目录> "<业务词>"');
    process.exit(1);
  }

  const hits = await searchBridge(wikiRoot, query ?? "");
  if (hits.length === 0) {
    process.stdout.write("未匹配到指标卡。可以直接读 metrics/_overview.md 手动找。\n");
  } else {
    for (const hit of hits) {
      const lines = [
        `【${hit.id}】（相关度 ${hit.score}）`,
        hit.metricFile ? `  指标口径：${hit.metricFile}` : "",
        hit.triggerWords.length ? `  同义说法：${hit.triggerWords.slice(0, 8).join("、")}` : "",
        hit.relatedQueries.length ? `  现成 SQL：${hit.relatedQueries.slice(0, 3).join("、")}` : "",
      ].filter(Boolean);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
  }
}
