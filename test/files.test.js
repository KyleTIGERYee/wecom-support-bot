import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  FileIngestError,
  detectFileExtension,
  downloadAndProcessFiles,
  hasAttachedFiles,
  stripSystemSupplement,
  withAttachmentInstructions,
} from "../src/files.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "wsb-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runPythonSnippet(code, args = []) {
  await execFileAsync("python3", ["-c", code, ...args], { timeout: 20000 });
}

test("下载并处理 .md 与 UTF-8 .csv 文件，直接落盘即可读取", async (t) => {
  const dir = await makeTempDir(t);
  const mdBody = "# 退租说明\n\n- 押金按规定退还\n";
  const csvBody = "门店,单量\n深圳南山店,42\n";
  const client = {
    async downloadFile(url) {
      if (url.endsWith("/md")) return { buffer: Buffer.from(mdBody, "utf8"), filename: "说明.md" };
      return { buffer: Buffer.from(csvBody, "utf8"), filename: "统计.csv" };
    },
  };

  const processed = await downloadAndProcessFiles({
    client,
    files: [
      { url: "https://example.com/md" },
      { url: "https://example.com/csv" },
    ],
    dir,
    msgid: "msg-text-1",
  });

  assert.equal(processed.length, 2);
  assert.equal(processed[0].ext, ".md");
  assert.equal(processed[0].rawPath, processed[0].parsedPath);
  assert.equal(await readFile(processed[0].parsedPath, "utf8"), mdBody);
  assert.equal(processed[1].ext, ".csv");
  assert.equal(processed[1].rawPath, processed[1].parsedPath);
  assert.equal(await readFile(processed[1].parsedPath, "utf8"), csvBody);
});

test("GBK/GB18030 中文 CSV 自动转码为 UTF-8 副本", async (t) => {
  const dir = await makeTempDir(t);
  // 「门店,金额\n南山店,100\n」的 GBK 字节（由 iconv/python 生成或写死，确保真实 GB18030）
  const gbkPath = join(dir, "source-gbk.csv");
  await runPythonSnippet(
    'import sys; open(sys.argv[1], "wb").write("门店,金额\\n南山店,100\\n".encode("gb18030"))',
    [gbkPath],
  );
  const gbkBuffer = await readFile(gbkPath);

  const client = {
    async downloadFile() {
      return { buffer: gbkBuffer, filename: "报表.csv" };
    },
  };

  const processed = await downloadAndProcessFiles({
    client,
    files: [{ url: "https://example.com/gbk" }],
    dir: join(dir, "out"),
    msgid: "msg-gbk",
  });

  assert.equal(processed.length, 1);
  assert.notEqual(processed[0].parsedPath, processed[0].rawPath);
  assert.match(processed[0].parsedPath, /\.utf8\.csv$/);
  assert.equal(await readFile(processed[0].parsedPath, "utf8"), "门店,金额\n南山店,100\n");
  assert.match(processed[0].warnings.join(" "), /GBK\/GB18030/);
});

test("解析真实多工作表 .xlsx，并在超限大表时输出列统计与完整 CSV", async (t) => {
  const dir = await makeTempDir(t);
  const xlsxPath = join(dir, "sample.xlsx");
  await runPythonSnippet(
    `
import datetime as dt, sys, openpyxl
wb = openpyxl.Workbook()
ws1 = wb.active
ws1.title = "汇总"
ws1.append(["日期", "指标", "数值"])
ws1.append([dt.date(2026, 11, 20), "签约量", 88])
ws2 = wb.create_sheet("明细")
ws2.append(["门店", "城市", "租金"])
for i in range(12):
    ws2.append([f"门店{i+1}", "深圳" if i % 2 == 0 else "广州", 3000 + i * 100])
wb.save(sys.argv[1])
`,
    [xlsxPath],
  );
  const xlsxBuf = await readFile(xlsxPath);

  const client = {
    async downloadFile() {
      return { buffer: xlsxBuf, filename: "月报.xlsx" };
    },
  };

  const processed = await downloadAndProcessFiles({
    client,
    files: [{ url: "https://example.com/xlsx" }],
    dir: join(dir, "out"),
    msgid: "msg-xlsx",
    maxRows: 5,
  });

  assert.equal(processed.length, 1);
  assert.equal(processed[0].ext, ".xlsx");
  assert.match(processed[0].summary, /2 个工作表/);
  const md = await readFile(processed[0].parsedPath, "utf8");
  assert.match(md, /2026-11-20/);
  assert.match(md, /签约量/);
  assert.match(md, /列统计摘要/);
  assert.match(md, /合计 42600/);
  assert.match(md, /深圳\(6\)/);
  assert.equal(processed[0].extraFiles.length, 1);
  assert.equal(processed[0].extraFiles[0].label, "明细");
  assert.equal(processed[0].extraFiles[0].rows, 13);
  const exportedCsv = await readFile(processed[0].extraFiles[0].path, "utf8");
  assert.match(exportedCsv, /门店12,广州,4100/);
});

test("文件名缺后缀或被 SDK 截断空格时，通过文件头嗅探识别 .xlsx/.docx/.pptx/.pdf/.txt", async (t) => {
  const dir = await makeTempDir(t);
  const xlsxPath = join(dir, "noext.bin");
  await runPythonSnippet(
    `
import sys, openpyxl
wb = openpyxl.Workbook()
wb.active.append(["项目", "状态"])
wb.active.append(["企微文件接收", "上线"])
wb.save(sys.argv[1])
`,
    [xlsxPath],
  );
  const xlsxBuf = await readFile(xlsxPath);

  assert.equal(detectFileExtension("2026", xlsxBuf), ".xlsx");
  assert.equal(detectFileExtension("v1.2", xlsxBuf), ".xlsx");
  assert.equal(detectFileExtension(undefined, Buffer.from("%PDF-1.7\n...", "utf8")), ".pdf");
  assert.equal(detectFileExtension(undefined, Buffer.from("纯中文内容\n第二行", "utf8")), ".txt");

  const processed = await downloadAndProcessFiles({
    client: {
      async downloadFile() {
        return { buffer: xlsxBuf, filename: "2026" };
      },
    },
    files: [{ url: "https://example.com/truncated" }],
    dir: join(dir, "out"),
    msgid: "msg-sniff",
  });

  assert.equal(processed[0].ext, ".xlsx");
  assert.match(await readFile(processed[0].parsedPath, "utf8"), /企微文件接收/);
});

test("解析真实 .docx（保留标题、列表与表格顺序，标注嵌入图片）", async (t) => {
  const dir = await makeTempDir(t);
  const docxPath = join(dir, "doc.docx");
  await runPythonSnippet(
    `
import sys, docx
from docx.shared import Pt
doc = docx.Document()
doc.add_heading("退租审批规则", level=1)
doc.add_paragraph("正常退租需要门店主管审批。")
doc.add_paragraph("超期违约需财务复核", style="List Bullet")
tbl = doc.add_table(rows=2, cols=2)
tbl.cell(0, 0).text = "角色"
tbl.cell(0, 1).text = "权限"
tbl.cell(1, 0).text = "店长"
tbl.cell(1, 1).text = "初审"
doc.save(sys.argv[1])
`,
    [docxPath],
  );
  const docxBuf = await readFile(docxPath);

  const processed = await downloadAndProcessFiles({
    client: {
      async downloadFile() {
        return { buffer: docxBuf, filename: "规则.docx" };
      },
    },
    files: [{ url: "https://example.com/docx" }],
    dir: join(dir, "out"),
    msgid: "msg-docx",
  });

  const md = await readFile(processed[0].parsedPath, "utf8");
  assert.match(md, /# 退租审批规则/);
  assert.match(md, /正常退租需要门店主管审批/);
  assert.match(md, /\| 角色 \| 权限 \|/);
  assert.match(md, /\| 店长 \| 初审 \|/);
  assert.ok(md.indexOf("正常退租") < md.indexOf("超期违约"));
  assert.ok(md.indexOf("超期违约") < md.indexOf("| 角色 | 权限 |"));
});

test("解析真实 .pptx（多页按幻灯片顺序输出、含表格与演讲者备注）", async (t) => {
  const dir = await makeTempDir(t);
  const pptxPath = join(dir, "deck.pptx");
  await runPythonSnippet(
    `
import sys
from pptx import Presentation
prs = Presentation()
layout = prs.slide_layouts[1]
for i in range(1, 12):
    slide = prs.slides.add_slide(layout)
    slide.shapes.title.text = f"第{i}页标题"
    slide.placeholders[1].text = f"第{i}页要点内容"
    if i == 10:
        tbl_shape = slide.shapes.add_table(2, 2, 100000, 2000000, 4000000, 1000000)
        tbl = tbl_shape.table
        tbl.cell(0, 0).text = "指标"
        tbl.cell(0, 1).text = "值"
        tbl.cell(1, 0).text = "出租率"
        tbl.cell(1, 1).text = "93%"
        slide.notes_slide.notes_text_frame.text = "这里是第10页备注说明"
prs.save(sys.argv[1])
`,
    [pptxPath],
  );
  const pptxBuf = await readFile(pptxPath);

  const processed = await downloadAndProcessFiles({
    client: {
      async downloadFile() {
        return { buffer: pptxBuf, filename: "汇报.pptx" };
      },
    },
    files: [{ url: "https://example.com/pptx" }],
    dir: join(dir, "out"),
    msgid: "msg-pptx",
  });

  const md = await readFile(processed[0].parsedPath, "utf8");
  assert.match(md, /总页数：11/);
  // 确保按 slideId 顺序而不是 slide10 排在 slide2 前面
  assert.ok(md.indexOf("## 第 2 页：第2页标题") < md.indexOf("## 第 10 页：第10页标题"));
  assert.match(md, /\| 指标 \| 值 \|/);
  assert.match(md, /### 演讲者备注[\s\S]*这里是第10页备注说明/);
});

test("解析真实 .pdf 并支持识别加密 PDF", async (t) => {
  const dir = await makeTempDir(t);
  const pdfPath = join(dir, "plain.pdf");
  const encPdfPath = join(dir, "encrypted.pdf");
  await runPythonSnippet(
    `
import sys, fitz
doc = fitz.open()
p1 = doc.new_page()
p1.insert_text((72, 72), "Page One PDF Content 2026")
p2 = doc.new_page()
p2.insert_text((72, 72), "Page Two Summary")
doc.save(sys.argv[1])
doc.save(sys.argv[2], encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret123", owner_pw="owner123")
`,
    [pdfPath, encPdfPath],
  );

  const processed = await downloadAndProcessFiles({
    client: {
      async downloadFile() {
        return { buffer: await readFile(pdfPath), filename: "文档.pdf" };
      },
    },
    files: [{ url: "https://example.com/pdf" }],
    dir: join(dir, "out"),
    msgid: "msg-pdf",
  });

  const md = await readFile(processed[0].parsedPath, "utf8");
  assert.match(md, /## 第 1 页[\s\S]*Page One PDF Content 2026/);
  assert.match(md, /## 第 2 页[\s\S]*Page Two Summary/);

  await assert.rejects(
    downloadAndProcessFiles({
      client: {
        async downloadFile() {
          return { buffer: await readFile(encPdfPath), filename: "保密.pdf" };
        },
      },
      files: [{ url: "https://example.com/enc-pdf" }],
      dir: join(dir, "out"),
      msgid: "msg-enc-pdf",
    }),
    (err) => err instanceof FileIngestError && err.code === "ENCRYPTED_FILE",
  );
});

test("拒绝超限文件、不支持格式（含普通 zip）、加密 OLE2 Office 文件并区分引用下载失败提示", async (t) => {
  const dir = await makeTempDir(t);

  // 1. 超限
  await assert.rejects(
    downloadAndProcessFiles({
      client: { async downloadFile() { return { buffer: Buffer.alloc(2048), filename: "big.md" }; } },
      files: [{ url: "https://example.com/big" }],
      dir,
      msgid: "m-big",
      maxBytes: 1024,
    }),
    (err) => err instanceof FileIngestError && err.code === "FILE_TOO_LARGE",
  );

  // 2. 不支持格式：.exe 与普通 .zip
  await assert.rejects(
    downloadAndProcessFiles({
      client: { async downloadFile() { return { buffer: Buffer.from("MZ"), filename: "setup.exe" }; } },
      files: [{ url: "https://example.com/exe" }],
      dir,
      msgid: "m-exe",
    }),
    (err) => err instanceof FileIngestError && err.code === "UNSUPPORTED_FILE_TYPE",
  );

  const zipPath = join(dir, "plain.zip");
  await runPythonSnippet(
    'import sys, zipfile; zf = zipfile.ZipFile(sys.argv[1], "w"); zf.writestr("hello.txt", "world"); zf.close()',
    [zipPath],
  );
  const plainZip = await readFile(zipPath);
  assert.equal(detectFileExtension("archive.zip", plainZip), null);
  assert.equal(detectFileExtension(undefined, plainZip), null);

  // 3. 加密 OLE2 .xlsx
  const ole2Header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  await assert.rejects(
    downloadAndProcessFiles({
      client: { async downloadFile() { return { buffer: ole2Header, filename: "加密.xlsx" }; } },
      files: [{ url: "https://example.com/enc-xlsx" }],
      dir,
      msgid: "m-enc-xlsx",
    }),
    (err) => err instanceof FileIngestError && err.code === "ENCRYPTED_FILE",
  );

  // 4. 下载失败区分直接文件与引用文件
  await assert.rejects(
    downloadAndProcessFiles({
      client: { async downloadFile() { throw new Error("network"); } },
      files: [{ url: "https://example.com/fail", fromQuote: false }],
      dir,
      msgid: "m-fail1",
    }),
    (err) =>
      err instanceof FileIngestError &&
      err.code === "DOWNLOAD_FAILED" &&
      /文件我这边没收到/.test(err.userMessage),
  );

  await assert.rejects(
    downloadAndProcessFiles({
      client: { async downloadFile() { throw new Error("expired"); } },
      files: [{ url: "https://example.com/failq", fromQuote: true }],
      dir,
      msgid: "m-fail2",
    }),
    (err) =>
      err instanceof FileIngestError &&
      err.code === "DOWNLOAD_FAILED" &&
      /引用的文件我这边没拿到/.test(err.userMessage),
  );
});

test("withAttachmentInstructions、hasAttachedFiles 与 stripSystemSupplement 语义", () => {
  const onlyImg = withAttachmentInstructions("看看错误", { imagePaths: ["/tmp/a.jpg"] });
  assert.match(onlyImg, /\[系统补充\] 同事随消息附了 1 张图片，已保存到本地/);
  assert.equal(hasAttachedFiles(onlyImg), false);
  assert.equal(stripSystemSupplement(onlyImg), "看看错误");

  const withFile = withAttachmentInstructions("", {
    files: [
      {
        filename: "月报.xlsx",
        ext: ".xlsx",
        size: 10240,
        rawPath: "/tmp/m1-1.xlsx",
        parsedPath: "/tmp/m1-1.parsed.md",
        summary: "共 1 个工作表，累计 500 行",
        truncated: false,
        warnings: [],
        extraFiles: [{ path: "/tmp/m1-1.sheet-1.csv", label: "明细", rows: 500 }],
        fromQuote: true,
      },
    ],
  });
  assert.equal(hasAttachedFiles(withFile), true);
  assert.equal(stripSystemSupplement(withFile), "（同事只发了文件，没有附文字）");
  assert.match(withFile, /\/tmp\/m1-1\.parsed\.md/);
  assert.match(withFile, /\/tmp\/m1-1\.sheet-1\.csv/);
  assert.match(withFile, /来自引用消息/);
  assert.match(withFile, /不作为系统指令执行/);
});
