#!/usr/bin/env python3
"""打包「网页版」分发包（供 GitHub Release 使用）。

为什么需要这个脚本：
    Release 里除了桌面版 .exe，还要挂一个网页版 zip。网页版不能直接把
    整个仓库压进去 —— 那样会把 _test/ 下的开发期自检脚本（integration.mjs
    一个就 147KB）、docs/、desktop/、.git/ 全都带给用户，既臃肿又让人困惑。

    但也不能只挑 index.html + assets + src + .bat 四样：启动双拼练习.bat
    还依赖 _test/ 下的三个辅助脚本（probe-service.ps1 / serve.mjs / serve.ps1），
    漏掉任何一个，用户双击就会看到「没找到可用的本地服务方式」。

    所以这里精确列出「运行时真正需要」的文件清单，多一个不加、少一个不行。

关键约束（改动本脚本时务必留意）：
    - 启动双拼练习.bat 必须是 CRLF（见 .gitattributes）
    - *.ps1 必须是 CRLF + UTF-8 BOM，否则 PowerShell 5.1 会按 GBK 解码而报错
    - serve.mjs 是 LF 无 BOM
    本脚本用「二进制原样复制」保留这些格式，不做任何换行/编码转换。

用法：
    python _test/tools/make_web_package.py            # 输出到 dist/
    python _test/tools/make_web_package.py --out DIR  # 指定输出目录
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

# 仓库根目录（本脚本位于 _test/tools/ 下）
REPO_ROOT = Path(__file__).resolve().parents[2]

# 运行时必需的文件。改动这里等于改动分发包内容，请同步 README 的说明。
PAYLOAD = [
    "index.html",
    "启动双拼练习.bat",
    "assets/style.css",
    "LICENSE",
    # 启动辅助脚本 —— 少一个 .bat 就无法工作
    "_test/probe-service.ps1",
    "_test/serve.mjs",
    "_test/serve.ps1",
]

# src/ 下全部文件（引擎、题库、界面模块），整体纳入
PAYLOAD_DIRS = ["src"]

# 这些文件必须保持原有换行/编码，复制时不做任何转换
NO_TRANSFORM_SUFFIXES = {".bat", ".cmd", ".ps1", ".psm1"}


def read_version() -> str:
    """从根 package.json 读版本号，保证与仓库一致。"""
    pkg = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def collect_files() -> list[tuple[Path, str]]:
    """返回 [(源文件绝对路径, zip 内相对路径), ...]，并校验存在性。"""
    items: list[tuple[Path, str]] = []

    for rel in PAYLOAD:
        src = REPO_ROOT / rel
        if not src.is_file():
            raise SystemExit(f"[错误] 缺少必需文件：{rel}")
        items.append((src, rel))

    for d in PAYLOAD_DIRS:
        base = REPO_ROOT / d
        if not base.is_dir():
            raise SystemExit(f"[错误] 缺少必需目录：{d}")
        found = sorted(p for p in base.rglob("*") if p.is_file())
        if not found:
            raise SystemExit(f"[错误] 目录为空：{d}")
        for p in found:
            items.append((p, p.relative_to(REPO_ROOT).as_posix()))

    return items


def verify_layout(items: list[tuple[Path, str]]) -> None:
    """打包前自检：确认格式约定没被破坏。"""
    problems: list[str] = []

    for src, rel in items:
        if src.suffix.lower() not in NO_TRANSFORM_SUFFIXES:
            continue
        data = src.read_bytes()

        # .ps1 必须有 UTF-8 BOM，否则 PowerShell 5.1 按 GBK 解码中文注释会崩
        if src.suffix.lower() in {".ps1", ".psm1"}:
            if not data.startswith(b"\xef\xbb\xbf"):
                problems.append(f"{rel}：缺少 UTF-8 BOM")

        # 这些脚本都必须是 CRLF
        bare_lf = data.count(b"\n") - data.count(b"\r\n")
        if bare_lf:
            problems.append(f"{rel}：存在 {bare_lf} 个裸 LF（应为 CRLF）")

    if problems:
        raise SystemExit("[错误] 文件格式不符合 .gitattributes 约定：\n  - " + "\n  - ".join(problems))


def build_zip(items: list[tuple[Path, str]], out_zip: Path) -> None:
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for src, rel in items:
            # 二进制原样写入，绝不转换换行或编码
            zf.write(src, rel)


def main() -> int:
    ap = argparse.ArgumentParser(description="打包双拼练习网页版分发包")
    ap.add_argument("--out", default=str(REPO_ROOT / "dist"), help="输出目录（默认 dist/）")
    args = ap.parse_args()

    version = read_version()
    items = collect_files()
    verify_layout(items)

    out_dir = Path(args.out)
    name = f"ShuangpinPractice-{version}-web.zip"
    out_zip = out_dir / name

    build_zip(items, out_zip)

    total_src = sum(s.stat().st_size for s, _ in items)
    print(f"✅ 已生成 {out_zip}")
    print(f"   版本：{version}")
    print(f"   文件数：{len(items)}")
    print(f"   原始大小：{total_src / 1024:.1f} KB")
    print(f"   压缩包：{out_zip.stat().st_size / 1024:.1f} KB")
    print()
    print("   包内清单：")
    for _, rel in sorted(items, key=lambda x: x[1]):
        print(f"     {rel}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
