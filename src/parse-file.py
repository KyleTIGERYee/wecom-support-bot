#!/usr/bin/env python3
"""
本地文档解析器：把企业微信接收的常见办公文档（Excel / Word / PPT / PDF）
转换成结构化 Markdown（大表附列统计与完整 CSV），输出单行 JSON 给 Node 网关消费。
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_MAGIC = b"PK\x03\x04"

MAX_ZIP_ENTRIES = 5000
MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_ZIP_MEMBER_BYTES = 30 * 1024 * 1024

MAX_SCAN_ROWS = 50000
MAX_SCAN_COLS = 500
MAX_TRAILING_EMPTY_ROWS = 200
SOFFICE_TIMEOUT_SEC = 20

NUMERIC_RE = re.compile(r"^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")
LEADING_ZERO_INT_RE = re.compile(r"^-?0\d+$")
CELL_REF_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


class ParseError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def emit_json(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def find_soffice() -> Optional[str]:
    for candidate in (
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        "/opt/homebrew/bin/soffice",
        "/usr/local/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def convert_with_soffice_and_parse(
    input_path: str,
    target_ext: str,
    parser_fn: Callable[[str], Any],
    timeout_sec: int = SOFFICE_TIMEOUT_SEC,
) -> Any:
    soffice = find_soffice()
    if not soffice:
        raise ParseError("PARSE_FAILED", f"缺少 LibreOffice (soffice)，无法转换 .{target_ext} 旧版格式文件")
    tmpdir = tempfile.mkdtemp(prefix="wsb-soffice-")
    try:
        profile_dir = os.path.join(tmpdir, "lo-profile")
        out_dir = os.path.join(tmpdir, "out")
        os.makedirs(out_dir, exist_ok=True)
        cmd = [
            soffice,
            "--headless",
            "--norestore",
            f"-env:UserInstallation=file://{profile_dir}",
            "--convert-to",
            target_ext,
            "--outdir",
            out_dir,
            input_path,
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise ParseError("PARSE_FAILED", f"格式转换超时（>{timeout_sec}秒）")
        except Exception as exc:
            raise ParseError("PARSE_FAILED", f"启动格式转换失败：{exc}")

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            tail = detail[-1] if detail else f"exit={proc.returncode}"
            if "password" in tail.lower() or "encrypt" in tail.lower():
                raise ParseError("ENCRYPTED_FILE", "文件已加密，无法转换")
            raise ParseError("PARSE_FAILED", f"格式转换失败：{tail}")

        candidates = [
            os.path.join(out_dir, name)
            for name in os.listdir(out_dir)
            if name.lower().endswith(f".{target_ext.lower()}")
        ]
        if not candidates:
            raise ParseError("PARSE_FAILED", "格式转换未生成目标文件")
        return parser_fn(candidates[0])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def check_ooxml_container(path: str) -> None:
    with open(path, "rb") as fp:
        head = fp.read(8)
    if head == OLE2_MAGIC:
        raise ParseError("ENCRYPTED_FILE", "文件已加密（Office 加密容器），无法直接解析")


def open_safe_zip(path: str) -> zipfile.ZipFile:
    check_ooxml_container(path)
    try:
        zf = zipfile.ZipFile(path, "r")
    except zipfile.BadZipFile as exc:
        raise ParseError("PARSE_FAILED", f"文件不是有效的压缩文档格式：{exc}")
    except Exception as exc:
        raise ParseError("PARSE_FAILED", f"无法打开文档：{exc}")

    infos = zf.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        zf.close()
        raise ParseError("PARSE_FAILED", f"文档内部条目过多（{len(infos)} > {MAX_ZIP_ENTRIES}），拒绝解析")

    total_size = 0
    for info in infos:
        if info.file_size < 0:
            zf.close()
            raise ParseError("PARSE_FAILED", "文档内部存在异常文件大小")
        total_size += info.file_size
        if total_size > MAX_ZIP_UNCOMPRESSED_BYTES:
            zf.close()
            raise ParseError("PARSE_FAILED", "文档解压后总大小超过 100MB 安全上限")
    return zf


def read_zip_member(zf: zipfile.ZipFile, member_name: str, limit: int = MAX_ZIP_MEMBER_BYTES) -> bytes:
    with zf.open(member_name, "r") as fp:
        data = fp.read(limit + 1)
    if len(data) > limit:
        raise ParseError("PARSE_FAILED", f"文档成员 {member_name} 超过 {limit // (1024 * 1024)}MB 限制")
    return data


def parse_xml_bytes(data: bytes) -> ET.Element:
    head = data[:4096].decode("utf-8", errors="ignore")
    if "<!ENTITY" in head.upper():
        raise ParseError("PARSE_FAILED", "XML 包含不安全的实体声明，拒绝解析")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ParseError("PARSE_FAILED", f"XML 解析失败：{exc}")


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def attr_value(elem: ET.Element, target_local: str) -> Optional[str]:
    for key, value in elem.attrib.items():
        if local_name(key) == target_local:
            return value
    return None


def md_cell(text: str) -> str:
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    cleaned = cleaned.replace("|", "\\|").replace("\n", "<br>")
    return cleaned


def render_markdown_table(rows: List[List[str]]) -> str:
    if not rows:
        return ""
    col_count = max(len(r) for r in rows)
    if col_count == 0:
        return ""
    normalized: List[List[str]] = []
    for r in rows:
        padded = list(r) + [""] * (col_count - len(r))
        normalized.append([md_cell(c) for c in padded])

    header = [cell if cell else f"列{i + 1}" for i, cell in enumerate(normalized[0])]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * col_count) + " |",
    ]
    for row in normalized[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def format_cell_value(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    if isinstance(val, dt.datetime):
        if val.hour == 0 and val.minute == 0 and val.second == 0:
            return val.strftime("%Y-%m-%d")
        return val.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(val, dt.date):
        return val.strftime("%Y-%m-%d")
    if isinstance(val, dt.time):
        return val.strftime("%H:%M:%S")
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            return ""
        if val.is_integer() and abs(val) < 1e15:
            return str(int(val))
        return str(val)
    return str(val).strip()


def trim_sheet_rows(raw_rows: List[List[str]]) -> List[List[str]]:
    # 去掉尾部全空行
    while raw_rows and all(cell == "" for cell in raw_rows[-1]):
        raw_rows.pop()
    if not raw_rows:
        return []
    max_col = 0
    for row in raw_rows:
        for idx in range(len(row) - 1, -1, -1):
            if row[idx] != "":
                if idx + 1 > max_col:
                    max_col = idx + 1
                break
    if max_col == 0:
        return []
    return [row[:max_col] + [""] * max(0, max_col - len(row)) for row in raw_rows]


def col_letters_to_index(letters: str) -> int:
    idx = 0
    for ch in letters.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def extract_xlsx_with_openpyxl(path: str, data_only: bool) -> Tuple[List[Dict[str, Any]], List[str]]:
    import openpyxl  # type: ignore

    warnings: List[str] = []
    sheets: List[Dict[str, Any]] = []
    wb = openpyxl.load_workbook(path, read_only=True, data_only=data_only)
    try:
        for name in wb.sheetnames:
            ws = wb[name]
            collected: List[List[str]] = []
            pending_empty: List[List[str]] = []
            consecutive_empty = 0
            truncated_scan = False
            row_idx = 0

            for row_values in ws.iter_rows(values_only=True):
                row_idx += 1
                if row_idx > MAX_SCAN_ROWS:
                    truncated_scan = True
                    warnings.append(f"工作表「{name}」超过 {MAX_SCAN_ROWS} 行扫描上限，仅保留前 {MAX_SCAN_ROWS} 行")
                    break
                limited = list(row_values)[:MAX_SCAN_COLS]
                formatted = [format_cell_value(v) for v in limited]
                if all(c == "" for c in formatted):
                    consecutive_empty += 1
                    if consecutive_empty >= MAX_TRAILING_EMPTY_ROWS:
                        break
                    pending_empty.append(formatted)
                else:
                    if pending_empty:
                        collected.extend(pending_empty)
                        pending_empty.clear()
                    consecutive_empty = 0
                    collected.append(formatted)

            trimmed = trim_sheet_rows(collected)
            sheets.append(
                {
                    "name": str(name),
                    "rows": trimmed,
                    "total_rows": len(trimmed),
                    "total_cols": len(trimmed[0]) if trimmed else 0,
                    "truncated_scan": truncated_scan,
                }
            )
    finally:
        wb.close()
    return sheets, warnings


def resolve_zip_rel_path(base_dir: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    combined = posixpath.normpath(posixpath.join(base_dir, target))
    return combined.lstrip("/")


def parse_rels_map(zf: zipfile.ZipFile, rels_path: str) -> Dict[str, Tuple[str, str]]:
    if rels_path not in zf.namelist():
        return {}
    root = parse_xml_bytes(read_zip_member(zf, rels_path))
    result: Dict[str, Tuple[str, str]] = {}
    for child in root:
        if local_name(child.tag) == "Relationship":
            rid = child.attrib.get("Id", "")
            rtype = child.attrib.get("Type", "")
            target = child.attrib.get("Target", "")
            if rid and target:
                result[rid] = (rtype, target)
    return result


def extract_xlsx_with_stdlib(path: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    sheets: List[Dict[str, Any]] = []
    with open_safe_zip(path) as zf:
        names = set(zf.namelist())
        if "xl/workbook.xml" not in names:
            raise ParseError("PARSE_FAILED", "缺少 xl/workbook.xml，不是有效的 xlsx 文件")

        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in names:
            ss_root = parse_xml_bytes(read_zip_member(zf, "xl/sharedStrings.xml"))
            for si in ss_root:
                if local_name(si.tag) != "si":
                    continue
                parts: List[str] = []
                for elem in si.iter():
                    if local_name(elem.tag) == "t" and elem.text:
                        parts.append(elem.text)
                shared_strings.append("".join(parts))

        wb_root = parse_xml_bytes(read_zip_member(zf, "xl/workbook.xml"))
        rels = parse_rels_map(zf, "xl/_rels/workbook.xml.rels")

        sheet_defs: List[Tuple[str, str]] = []
        for elem in wb_root.iter():
            if local_name(elem.tag) == "sheet":
                sname = elem.attrib.get("name", f"Sheet{len(sheet_defs) + 1}")
                rid = attr_value(elem, "id")
                if rid and rid in rels:
                    _, target = rels[rid]
                    sheet_defs.append((sname, resolve_zip_rel_path("xl", target)))

        if not sheet_defs:
            sheet_files = sorted(n for n in names if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
            sheet_defs = [(posixpath.basename(n), n) for n in sheet_files]

        for sname, spath in sheet_defs:
            if spath not in names:
                continue
            sheet_root = parse_xml_bytes(read_zip_member(zf, spath))
            collected: List[List[str]] = []
            pending_empty: List[List[str]] = []
            consecutive_empty = 0
            truncated_scan = False
            row_count = 0

            for row_elem in sheet_root.iter():
                if local_name(row_elem.tag) != "row":
                    continue
                row_count += 1
                if row_count > MAX_SCAN_ROWS:
                    truncated_scan = True
                    warnings.append(f"工作表「{sname}」超过 {MAX_SCAN_ROWS} 行扫描上限，仅保留前 {MAX_SCAN_ROWS} 行")
                    break

                row_cells: Dict[int, str] = {}
                next_col = 0
                for c_elem in row_elem:
                    if local_name(c_elem.tag) != "c":
                        continue
                    ref = c_elem.attrib.get("r", "")
                    m = CELL_REF_RE.match(ref)
                    if m:
                        col_idx = col_letters_to_index(m.group(1))
                    else:
                        col_idx = next_col
                    next_col = col_idx + 1
                    if col_idx >= MAX_SCAN_COLS:
                        continue

                    ctype = c_elem.attrib.get("t", "")
                    val_text = ""
                    if ctype == "inlineStr":
                        parts = [
                            el.text
                            for el in c_elem.iter()
                            if local_name(el.tag) == "t" and el.text
                        ]
                        val_text = "".join(parts)
                    else:
                        v_elem = None
                        for sub in c_elem:
                            if local_name(sub.tag) == "v":
                                v_elem = sub
                                break
                        raw_v = v_elem.text if v_elem is not None and v_elem.text is not None else ""
                        if ctype == "s":
                            try:
                                idx = int(raw_v)
                                val_text = shared_strings[idx] if 0 <= idx < len(shared_strings) else ""
                            except ValueError:
                                val_text = ""
                        elif ctype == "b":
                            val_text = "TRUE" if raw_v == "1" else "FALSE"
                        else:
                            val_text = raw_v
                    val_text = val_text.strip()
                    if val_text != "":
                        row_cells[col_idx] = val_text

                if not row_cells:
                    consecutive_empty += 1
                    if consecutive_empty >= MAX_TRAILING_EMPTY_ROWS:
                        break
                    pending_empty.append([])
                else:
                    max_c = max(row_cells.keys())
                    row_list = [row_cells.get(i, "") for i in range(max_c + 1)]
                    if pending_empty:
                        collected.extend(pending_empty)
                        pending_empty.clear()
                    consecutive_empty = 0
                    collected.append(row_list)

            trimmed = trim_sheet_rows(collected)
            sheets.append(
                {
                    "name": sname,
                    "rows": trimmed,
                    "total_rows": len(trimmed),
                    "total_cols": len(trimmed[0]) if trimmed else 0,
                    "truncated_scan": truncated_scan,
                }
            )
    return sheets, warnings


def parse_xlsx_sheets(path: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    check_ooxml_container(path)
    # 先验证 ZIP 安全边界（含防炸弹），再交由 openpyxl 或 stdlib 解析
    with open_safe_zip(path):
        pass

    try:
        sheets, warnings = extract_xlsx_with_openpyxl(path, data_only=True)
        total_nonempty_rows = sum(s["total_rows"] for s in sheets)
        if total_nonempty_rows == 0:
            formula_sheets, formula_warnings = extract_xlsx_with_openpyxl(path, data_only=False)
            if sum(s["total_rows"] for s in formula_sheets) > 0:
                sheets, warnings = formula_sheets, formula_warnings
                warnings.append("工作簿包含未缓存结果的公式，已按公式文本读取")
        return sheets, warnings
    except ParseError:
        raise
    except ImportError:
        return extract_xlsx_with_stdlib(path)
    except Exception:
        return extract_xlsx_with_stdlib(path)


def parse_xls_sheets(path: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    try:
        import xlrd  # type: ignore

        try:
            wb = xlrd.open_workbook(path)
        except Exception as exc:
            msg = str(exc).lower()
            if "encrypt" in msg or "password" in msg:
                raise ParseError("ENCRYPTED_FILE", "xls 文件已加密，无法直接解析")
            raise

        warnings: List[str] = []
        sheets: List[Dict[str, Any]] = []
        for idx in range(wb.nsheets):
            ws = wb.sheet_by_index(idx)
            collected: List[List[str]] = []
            pending_empty: List[List[str]] = []
            consecutive_empty = 0
            truncated_scan = False
            max_r = min(ws.nrows, MAX_SCAN_ROWS)
            if ws.nrows > MAX_SCAN_ROWS:
                truncated_scan = True
                warnings.append(f"工作表「{ws.name}」超过 {MAX_SCAN_ROWS} 行扫描上限，仅保留前 {MAX_SCAN_ROWS} 行")
            max_c = min(ws.ncols, MAX_SCAN_COLS)

            for r in range(max_r):
                row_vals: List[str] = []
                for c in range(max_c):
                    cell = ws.cell(r, c)
                    if cell.ctype == xlrd.XL_CELL_EMPTY:
                        row_vals.append("")
                    elif cell.ctype == xlrd.XL_CELL_DATE:
                        try:
                            dt_val = xlrd.xldate.xldate_as_datetime(cell.value, wb.datemode)
                            row_vals.append(format_cell_value(dt_val))
                        except Exception:
                            row_vals.append(format_cell_value(cell.value))
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        row_vals.append("TRUE" if cell.value else "FALSE")
                    elif cell.ctype == xlrd.XL_CELL_ERROR:
                        row_vals.append("")
                    else:
                        row_vals.append(format_cell_value(cell.value))
                if all(v == "" for v in row_vals):
                    consecutive_empty += 1
                    if consecutive_empty >= MAX_TRAILING_EMPTY_ROWS:
                        break
                    pending_empty.append(row_vals)
                else:
                    if pending_empty:
                        collected.extend(pending_empty)
                        pending_empty.clear()
                    consecutive_empty = 0
                    collected.append(row_vals)

            trimmed = trim_sheet_rows(collected)
            sheets.append(
                {
                    "name": str(ws.name),
                    "rows": trimmed,
                    "total_rows": len(trimmed),
                    "total_cols": len(trimmed[0]) if trimmed else 0,
                    "truncated_scan": truncated_scan,
                }
            )
        return sheets, warnings
    except ParseError:
        raise
    except Exception as exc:
        # 回退 soffice 转 xlsx
        try:
            return convert_with_soffice_and_parse(path, "xlsx", parse_xlsx_sheets)
        except ParseError:
            raise
        except Exception:
            raise ParseError("PARSE_FAILED", f"解析 xls 失败：{exc}")


def try_parse_number(text: str) -> Optional[float]:
    if not text or LEADING_ZERO_INT_RE.match(text):
        return None
    if not NUMERIC_RE.match(text):
        return None
    try:
        num = float(text.replace(",", ""))
        if math.isnan(num) or math.isinf(num):
            return None
        return num
    except ValueError:
        return None


def fmt_num(val: float) -> str:
    if val.is_integer() and abs(val) < 1e15:
        return str(int(val))
    return f"{val:.4f}".rstrip("0").rstrip(".")


def compute_column_stats_md(rows: List[List[str]]) -> str:
    if not rows:
        return ""
    has_header = len(rows) > 1
    headers = [rows[0][c] or f"列{c + 1}" for c in range(len(rows[0]))] if has_header else [f"列{c + 1}" for c in range(len(rows[0]))]
    data_rows = rows[1:] if has_header else rows
    total_data = len(data_rows)
    if total_data == 0:
        return ""

    lines = ["### 列统计摘要", f"统计样本：{total_data} 条数据行", ""]
    for c_idx, col_name in enumerate(headers):
        values = [r[c_idx] for r in data_rows if c_idx < len(r) and r[c_idx] != ""]
        non_empty = len(values)
        if non_empty == 0:
            lines.append(f"- **{col_name}**：全部为空（0/{total_data}）")
            continue

        nums = [try_parse_number(v) for v in values]
        valid_nums = [n for n in nums if n is not None]
        if len(valid_nums) == non_empty or (non_empty >= 5 and len(valid_nums) / non_empty >= 0.9):
            total_sum = sum(valid_nums)
            min_v = min(valid_nums)
            max_v = max(valid_nums)
            avg_v = total_sum / len(valid_nums)
            lines.append(
                f"- **{col_name}**：非空 {non_empty}/{total_data}，有效数值 {len(valid_nums)}，"
                f"合计 {fmt_num(total_sum)}，最小 {fmt_num(min_v)}，最大 {fmt_num(max_v)}，均值 {fmt_num(avg_v)}"
            )
        else:
            counts = Counter(values)
            distinct_cnt = len(counts)
            if distinct_cnt <= 20:
                top_items = ", ".join(f"{k}({v})" for k, v in counts.most_common(10))
                lines.append(f"- **{col_name}**：非空 {non_empty}/{total_data}，枚举值 {distinct_cnt} 种：{top_items}")
            else:
                top_items = ", ".join(f"{k}({v})" for k, v in counts.most_common(5))
                lines.append(f"- **{col_name}**：非空 {non_empty}/{total_data}，唯一值 {distinct_cnt} 种，高频前5：{top_items}")
    return "\n".join(lines)


def write_sheet_csv(csv_path: str, rows: List[List[str]]) -> None:
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, "w", encoding="utf-8", newline="") as fp:
        writer = csv.writer(fp, lineterminator="\n")
        writer.writerows(rows)


def render_sheets_markdown(
    sheets: List[Dict[str, Any]],
    warnings: List[str],
    display_name: str,
    fmt: str,
    output_md_path: str,
    max_rows: int,
    max_chars: int,
) -> Tuple[str, str, List[Dict[str, Any]]]:
    stem = output_md_path[:-10] if output_md_path.endswith(".parsed.md") else os.path.splitext(output_md_path)[0]
    extra_files: List[Dict[str, Any]] = []

    total_rows = sum(s["total_rows"] for s in sheets)
    overview_lines = [
        f"# 文件解析：{display_name}",
        "",
        f"- 格式：`{fmt}`",
        f"- 工作表数量：{len(sheets)}",
    ]
    for s in sheets:
        overview_lines.append(f"- 工作表「{s['name']}」：{s['total_rows']} 行 × {s['total_cols']} 列")

    sections: List[str] = ["\n".join(overview_lines)]

    def export_sheet_csv_once(idx: int, sheet: Dict[str, Any]) -> str:
        csv_path = f"{stem}.sheet-{idx}.csv"
        if not any(item["path"] == csv_path for item in extra_files):
            write_sheet_csv(csv_path, sheet["rows"])
            extra_files.append({"path": csv_path, "label": sheet["name"], "rows": sheet["total_rows"]})
        return csv_path

    # 先预判若全量渲染大概率超 max_chars 时，较大工作表也提前导出 CSV + 统计摘要
    for idx, sheet in enumerate(sheets, start=1):
        rows = sheet["rows"]
        sname = sheet["name"]
        part_lines = [f"## 工作表 {idx}：{sname}（{sheet['total_rows']} 行 × {sheet['total_cols']} 列）", ""]
        if not rows:
            part_lines.append("（工作表为空）")
            sections.append("\n".join(part_lines))
            continue

        need_large_extras = len(rows) > max_rows
        preview_rows = rows[:max_rows]
        part_lines.append(render_markdown_table(preview_rows))

        if len(rows) > max_rows:
            part_lines.append("")
            part_lines.append(f"注：表格仅展示前 {max_rows} 行，共 {len(rows)} 行（略去 {len(rows) - max_rows} 行）。")

        if need_large_extras:
            stats_md = compute_column_stats_md(rows)
            if stats_md:
                part_lines.append("")
                part_lines.append(stats_md)
            csv_path = export_sheet_csv_once(idx, sheet)
            part_lines.append("")
            part_lines.append(f"完整数据已导出为 CSV：`{csv_path}`（可用 read/rg/grep/wc 精确检索统计）")

        sections.append("\n".join(part_lines))

    markdown = "\n\n".join(sections) + "\n"

    # 若拼完所有工作表总字符仍超过 max_chars，把尚未导出 CSV 的多行表也补导一份，方便截断后仍可查
    if len(markdown) > max_chars:
        for idx, sheet in enumerate(sheets, start=1):
            if sheet["total_rows"] > 1:
                export_sheet_csv_once(idx, sheet)

    summary = f"共 {len(sheets)} 个工作表，累计 {total_rows} 行"
    return markdown, summary, extra_files


def extract_docx_paragraph_text(p_elem: ET.Element) -> str:
    parts: List[str] = []

    def visit(node: ET.Element) -> None:
        tag = local_name(node.tag)
        if tag in ("del", "moveFrom", "instrText"):
            return
        if tag == "t" or tag == "delText":
            if node.text:
                parts.append(node.text)
            return
        if tag == "tab":
            parts.append("    ")
            return
        if tag in ("br", "cr"):
            parts.append("\n")
            return
        for child in node:
            visit(child)

    visit(p_elem)
    return "".join(parts).strip()


def detect_docx_heading_level(p_elem: ET.Element) -> Optional[int]:
    for child in p_elem:
        if local_name(child.tag) != "pPr":
            continue
        for sub in child:
            if local_name(sub.tag) == "pStyle":
                val = attr_value(sub, "val") or ""
                if val.lower() == "title":
                    return 1
                if val.lower() == "subtitle":
                    return 2
                m = re.match(r"^(?:heading|标题)\s*([1-6])$", val.strip(), re.IGNORECASE)
                if m:
                    return int(m.group(1))
    return None


def has_docx_list_prop(p_elem: ET.Element) -> bool:
    for child in p_elem:
        if local_name(child.tag) == "pPr":
            for sub in child:
                if local_name(sub.tag) == "numPr":
                    return True
    return False


def extract_docx_table_rows(tbl_elem: ET.Element) -> List[List[str]]:
    rows: List[List[str]] = []
    for tr in tbl_elem:
        if local_name(tr.tag) != "tr":
            continue
        row: List[str] = []
        for tc in tr:
            if local_name(tc.tag) != "tc":
                continue
            cell_paras: List[str] = []
            for p in tc:
                if local_name(p.tag) == "p":
                    txt = extract_docx_paragraph_text(p)
                    if txt:
                        cell_paras.append(txt)
            row.append("\n".join(cell_paras))
        if any(cell != "" for cell in row):
            rows.append(row)
    return rows


def parse_docx(path: str, display_name: str, fmt: str = ".docx") -> Tuple[str, str, List[str]]:
    warnings: List[str] = []
    with open_safe_zip(path) as zf:
        names = zf.namelist()
        if "word/document.xml" not in names:
            raise ParseError("PARSE_FAILED", "缺少 word/document.xml，不是有效的 docx 文件")
        image_count = sum(1 for n in names if n.startswith("word/media/") and not n.endswith("/"))
        doc_root = parse_xml_bytes(read_zip_member(zf, "word/document.xml"))

    body = None
    for child in doc_root:
        if local_name(child.tag) == "body":
            body = child
            break
    if body is None:
        raise ParseError("PARSE_FAILED", "docx 缺少文档正文 body")

    blocks: List[str] = []
    para_count = 0
    table_count = 0

    for child in body:
        tag = local_name(child.tag)
        if tag == "p":
            txt = extract_docx_paragraph_text(child)
            if not txt:
                continue
            para_count += 1
            heading = detect_docx_heading_level(child)
            if heading is not None:
                blocks.append(f"{'#' * min(6, max(1, heading))} {txt}")
            elif has_docx_list_prop(child):
                blocks.append(f"- {txt}")
            else:
                blocks.append(txt)
        elif tag == "tbl":
            rows = extract_docx_table_rows(child)
            if rows:
                table_count += 1
                blocks.append(render_markdown_table(rows))

    if image_count > 0:
        warnings.append(f"文档包含 {image_count} 张嵌入图片（纯文本提取不含图片内容）")

    header_lines = [
        f"# 文件解析：{display_name}",
        "",
        f"- 格式：`{fmt}`",
        f"- 段落数：{para_count}，表格数：{table_count}" + (f"，嵌入图片：{image_count} 张" if image_count else ""),
    ]
    if not blocks:
        warnings.append("文档未提取到文字或表格内容")
        blocks.append("（未提取到文字或表格内容）")

    md = "\n".join(header_lines) + "\n\n" + "\n\n".join(blocks) + "\n"
    summary = f"{para_count} 段正文，{table_count} 个表格" + (f"，{image_count} 张图片" if image_count else "")
    return md, summary, warnings


def parse_doc(path: str, display_name: str) -> Tuple[str, str, List[str]]:
    try:
        return convert_with_soffice_and_parse(path, "docx", lambda converted: parse_docx(converted, display_name, ".doc"))
    except ParseError as exc:
        if exc.code == "ENCRYPTED_FILE":
            raise
    except Exception:
        pass

    # 回退 macOS textutil 或 antiword
    textutil = shutil.which("textutil") or ("/usr/bin/textutil" if os.path.isfile("/usr/bin/textutil") else None)
    if textutil:
        try:
            proc = subprocess.run(
                [textutil, "-convert", "txt", "-stdout", path],
                capture_output=True,
                text=True,
                timeout=SOFFICE_TIMEOUT_SEC,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                text = proc.stdout.strip()
                md = f"# 文件解析：{display_name}\n\n- 格式：`.doc`\n\n{text}\n"
                return md, f"共 {len(text.splitlines())} 行正文", ["通过 textutil 提取纯文本（不含复杂表格排版）"]
        except Exception:
            pass

    antiword = shutil.which("antiword")
    if antiword:
        try:
            proc = subprocess.run(
                [antiword, path],
                capture_output=True,
                text=True,
                timeout=SOFFICE_TIMEOUT_SEC,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                text = proc.stdout.strip()
                md = f"# 文件解析：{display_name}\n\n- 格式：`.doc`\n\n{text}\n"
                return md, f"共 {len(text.splitlines())} 行正文", ["通过 antiword 提取纯文本"]
        except Exception:
            pass

    raise ParseError("PARSE_FAILED", "无法解析旧版 .doc 文件（转换器不可用或文件已损坏/加密）")


def extract_drawingml_paragraphs(tx_body: ET.Element) -> List[str]:
    lines: List[str] = []
    for p in tx_body:
        if local_name(p.tag) != "p":
            continue
        parts: List[str] = []
        for elem in p.iter():
            t = local_name(elem.tag)
            if t == "t" and elem.text:
                parts.append(elem.text)
            elif t == "br":
                parts.append("\n")
        line = "".join(parts).strip()
        if line:
            lines.append(line)
    return lines


def extract_pptx_table_rows(tbl_elem: ET.Element) -> List[List[str]]:
    rows: List[List[str]] = []
    for tr in tbl_elem:
        if local_name(tr.tag) != "tr":
            continue
        row: List[str] = []
        for tc in tr:
            if local_name(tc.tag) != "tc":
                continue
            cell_lines: List[str] = []
            for sub in tc:
                if local_name(sub.tag) == "txBody":
                    cell_lines.extend(extract_drawingml_paragraphs(sub))
            row.append("\n".join(cell_lines))
        if any(cell != "" for cell in row):
            rows.append(row)
    return rows


def get_shape_placeholder_type(sp_elem: ET.Element) -> str:
    for elem in sp_elem.iter():
        if local_name(elem.tag) == "ph":
            return elem.attrib.get("type", "")
    return ""


def collect_pptx_slide_content(sp_tree: ET.Element) -> Tuple[Optional[str], List[str], int]:
    title_text: Optional[str] = None
    blocks: List[str] = []
    pic_count = 0

    def walk(container: ET.Element) -> None:
        nonlocal title_text, pic_count
        for child in container:
            tag = local_name(child.tag)
            if tag == "sp":
                ph_type = get_shape_placeholder_type(child)
                tx_body = None
                for sub in child:
                    if local_name(sub.tag) == "txBody":
                        tx_body = sub
                        break
                if tx_body is not None:
                    paras = extract_drawingml_paragraphs(tx_body)
                    if paras:
                        if ph_type in ("title", "ctrTitle") and title_text is None:
                            title_text = " ".join(paras)
                        else:
                            blocks.extend(paras)
            elif tag == "grpSp":
                walk(child)
            elif tag == "pic":
                pic_count += 1
            elif tag == "graphicFrame":
                for elem in child.iter():
                    if local_name(elem.tag) == "tbl":
                        rows = extract_pptx_table_rows(elem)
                        if rows:
                            blocks.append(render_markdown_table(rows))

    walk(sp_tree)
    return title_text, blocks, pic_count


def extract_pptx_notes(zf: zipfile.ZipFile, slide_path: str) -> List[str]:
    slide_dir = posixpath.dirname(slide_path)
    slide_base = posixpath.basename(slide_path)
    rels_path = posixpath.join(slide_dir, "_rels", f"{slide_base}.rels")
    rels = parse_rels_map(zf, rels_path)
    notes_paths: List[str] = []
    for _, (rtype, target) in rels.items():
        if rtype.endswith("/notesSlide") or "notesSlide" in target:
            resolved = resolve_zip_rel_path(slide_dir, target)
            if resolved in zf.namelist():
                notes_paths.append(resolved)

    notes_lines: List[str] = []
    for npath in notes_paths:
        nroot = parse_xml_bytes(read_zip_member(zf, npath))
        for elem in nroot.iter():
            if local_name(elem.tag) == "sp":
                ph_type = get_shape_placeholder_type(elem)
                if ph_type == "sldNum":
                    continue
                for sub in elem:
                    if local_name(sub.tag) == "txBody":
                        notes_lines.extend(extract_drawingml_paragraphs(sub))
    return notes_lines


def parse_pptx(path: str, display_name: str, fmt: str = ".pptx") -> Tuple[str, str, List[str]]:
    warnings: List[str] = []
    with open_safe_zip(path) as zf:
        names = set(zf.namelist())
        if "ppt/presentation.xml" not in names:
            raise ParseError("PARSE_FAILED", "缺少 ppt/presentation.xml，不是有效的 pptx 文件")

        pres_root = parse_xml_bytes(read_zip_member(zf, "ppt/presentation.xml"))
        pres_rels = parse_rels_map(zf, "ppt/_rels/presentation.xml.rels")

        slide_paths: List[str] = []
        for elem in pres_root.iter():
            if local_name(elem.tag) == "sldId":
                rid = attr_value(elem, "id")
                if rid and rid in pres_rels:
                    _, target = pres_rels[rid]
                    resolved = resolve_zip_rel_path("ppt", target)
                    if resolved in names:
                        slide_paths.append(resolved)

        if not slide_paths:
            def slide_num(p: str) -> int:
                m = re.search(r"slide(\d+)\.xml$", p)
                return int(m.group(1)) if m else 10**9

            slide_paths = sorted(
                (n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)),
                key=slide_num,
            )

        total_pics = 0
        slide_sections: List[str] = []
        for idx, spath in enumerate(slide_paths, start=1):
            sroot = parse_xml_bytes(read_zip_member(zf, spath))
            sp_tree = None
            for elem in sroot.iter():
                if local_name(elem.tag) == "spTree":
                    sp_tree = elem
                    break
            title_text = None
            blocks: List[str] = []
            pic_count = 0
            if sp_tree is not None:
                title_text, blocks, pic_count = collect_pptx_slide_content(sp_tree)
            total_pics += pic_count
            notes = extract_pptx_notes(zf, spath)

            heading = f"## 第 {idx} 页" + (f"：{title_text}" if title_text else "")
            lines = [heading, ""]
            if blocks:
                lines.extend(blocks)
            elif not title_text:
                lines.append("（本页无文本内容）")
            if pic_count > 0:
                lines.append("")
                lines.append(f"[本页含图片 {pic_count} 张]")
            if notes:
                lines.append("")
                lines.append("### 演讲者备注")
                lines.extend(notes)
            slide_sections.append("\n".join(lines))

    if total_pics > 0:
        warnings.append(f"演示文稿包含 {total_pics} 张图片（纯文本提取不含图片内容）")

    header_lines = [
        f"# 文件解析：{display_name}",
        "",
        f"- 格式：`{fmt}`",
        f"- 总页数：{len(slide_paths)}" + (f"，图片数：{total_pics}" if total_pics else ""),
    ]
    md = "\n".join(header_lines) + "\n\n" + "\n\n".join(slide_sections) + "\n"
    summary = f"共 {len(slide_paths)} 页" + (f"，含 {total_pics} 张图片" if total_pics else "")
    return md, summary, warnings


def parse_ppt(path: str, display_name: str) -> Tuple[str, str, List[str]]:
    return convert_with_soffice_and_parse(path, "pptx", lambda converted: parse_pptx(converted, display_name, ".ppt"))


def parse_pdf(path: str, display_name: str) -> Tuple[str, str, List[str]]:
    warnings: List[str] = []
    pages_text: List[str] = []
    last_error: Optional[Exception] = None

    def has_text(pages: List[str]) -> bool:
        return any(len(t) > 0 for t in pages)

    # 1. pypdf
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(path)
        if reader.is_encrypted:
            try:
                res = reader.decrypt("")
                if res == 0:
                    raise ParseError("ENCRYPTED_FILE", "PDF 文件已加密，无法提取内容")
            except ParseError:
                raise
            except Exception:
                raise ParseError("ENCRYPTED_FILE", "PDF 文件已加密，无法提取内容")
        pages_text = [(page.extract_text() or "").strip() for page in reader.pages]
    except ParseError:
        raise
    except Exception as exc:
        last_error = exc

    # 2. pdfplumber fallback（当 pypdf 失败或未提取出任何文字时尝试）
    if not has_text(pages_text):
        try:
            import pdfplumber  # type: ignore

            try:
                with pdfplumber.open(path) as pdf:
                    candidate = [(p.extract_text() or "").strip() for p in pdf.pages]
                    if has_text(candidate) or not pages_text:
                        pages_text = candidate
                    last_error = None
            except Exception as exc:
                if "password" in exc.__class__.__name__.lower() or "password" in str(exc).lower():
                    raise ParseError("ENCRYPTED_FILE", "PDF 文件已加密，无法提取内容")
                last_error = exc
        except ParseError:
            raise
        except ImportError:
            pass

    # 3. PyMuPDF (fitz) fallback
    if not has_text(pages_text):
        try:
            import fitz  # type: ignore

            doc = fitz.open(path)
            try:
                if doc.needs_pass:
                    raise ParseError("ENCRYPTED_FILE", "PDF 文件已加密，无法提取内容")
                candidate = [(page.get_text() or "").strip() for page in doc]
                if has_text(candidate) or not pages_text:
                    pages_text = candidate
                last_error = None
            finally:
                doc.close()
        except ParseError:
            raise
        except ImportError:
            pass
        except Exception as exc:
            last_error = exc

    if not pages_text and last_error is not None:
        raise ParseError("PARSE_FAILED", f"无法解析 PDF 文件：{last_error}")

    non_empty_chars = sum(len(t) for t in pages_text)
    if non_empty_chars == 0:
        warnings.append("未提取到文字，可能是扫描版或纯图片 PDF")

    sections = [
        f"# 文件解析：{display_name}",
        "",
        f"- 格式：`.pdf`",
        f"- 总页数：{len(pages_text)}",
    ]
    body_parts: List[str] = []
    for idx, txt in enumerate(pages_text, start=1):
        body_parts.append(f"## 第 {idx} 页\n\n{txt if txt else '（本页无文本内容）'}")

    md = "\n".join(sections) + "\n\n" + "\n\n".join(body_parts) + "\n"
    summary = f"共 {len(pages_text)} 页" + ("（未提取到文字）" if non_empty_chars == 0 else "")
    return md, summary, warnings


def truncate_markdown(text: str, max_chars: int) -> Tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    cut = max_chars
    nl = text.rfind("\n", max(0, max_chars - 1000), max_chars)
    if nl > max_chars // 2:
        cut = nl
    notice = f"\n\n……内容过长，已截断（原长 {len(text)} 字符，上限 {max_chars} 字符）……\n"
    return text[:cut] + notice, True


def parse_document(
    input_path: str,
    output_md_path: str,
    ext: str,
    display_name: str,
    max_rows: int,
    max_chars: int,
) -> Dict[str, Any]:
    if not os.path.isfile(input_path):
        raise ParseError("PARSE_FAILED", f"输入文件不存在：{input_path}")

    norm_ext = ext.lower()
    if not norm_ext.startswith("."):
        norm_ext = f".{norm_ext}"

    warnings: List[str] = []
    extra_files: List[Dict[str, Any]] = []

    if norm_ext in (".xlsx", ".xlsm"):
        sheets, warnings = parse_xlsx_sheets(input_path)
        md_text, summary, extra_files = render_sheets_markdown(
            sheets, warnings, display_name, norm_ext, output_md_path, max_rows, max_chars
        )
    elif norm_ext == ".xls":
        sheets, warnings = parse_xls_sheets(input_path)
        md_text, summary, extra_files = render_sheets_markdown(
            sheets, warnings, display_name, norm_ext, output_md_path, max_rows, max_chars
        )
    elif norm_ext == ".docx":
        md_text, summary, warnings = parse_docx(input_path, display_name)
    elif norm_ext == ".doc":
        md_text, summary, warnings = parse_doc(input_path, display_name)
    elif norm_ext == ".pptx":
        md_text, summary, warnings = parse_pptx(input_path, display_name)
    elif norm_ext == ".ppt":
        md_text, summary, warnings = parse_ppt(input_path, display_name)
    elif norm_ext == ".pdf":
        md_text, summary, warnings = parse_pdf(input_path, display_name)
    else:
        raise ParseError("UNSUPPORTED_FORMAT", f"不支持的文件格式：{norm_ext}")

    final_md, truncated = truncate_markdown(md_text, max_chars)
    if truncated:
        warnings.append(f"内容超过 {max_chars} 字符上限，已截断展示")

    os.makedirs(os.path.dirname(os.path.abspath(output_md_path)), exist_ok=True)
    with open(output_md_path, "w", encoding="utf-8") as fp:
        fp.write(final_md)

    return {
        "ok": True,
        "format": norm_ext,
        "parsedPath": os.path.abspath(output_md_path),
        "summary": summary,
        "truncated": truncated,
        "warnings": warnings,
        "extraFiles": extra_files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="本地解析办公文档为 Markdown")
    parser.add_argument("input_path", help="输入文件路径")
    parser.add_argument("output_md_path", help="输出 Markdown 路径")
    parser.add_argument("--ext", required=True, help="文件后缀（如 .xlsx）")
    parser.add_argument("--filename", default="", help="展示用的原始文件名")
    parser.add_argument("--max-rows", type=int, default=200, help="每个工作表最大渲染行数")
    parser.add_argument("--max-chars", type=int, default=180000, help="输出最大字符数")
    args = parser.parse_args()

    display_name = args.filename.strip() or os.path.basename(args.input_path)
    try:
        result = parse_document(
            input_path=args.input_path,
            output_md_path=args.output_md_path,
            ext=args.ext,
            display_name=display_name,
            max_rows=max(1, args.max_rows),
            max_chars=max(1000, args.max_chars),
        )
        emit_json(result)
        return 0
    except ParseError as exc:
        emit_json({"ok": False, "code": exc.code, "message": exc.message})
        return 1
    except Exception as exc:
        emit_json({"ok": False, "code": "PARSE_FAILED", "message": f"解析文件异常：{exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
