#!/usr/bin/env python3
"""打包「桌面版（Tauri）」分发包（供 GitHub Release 使用）。

背景：Tauri 版现在是**主力桌面版**，取代了原来的 Electron 版
（64.6 MB → 3.5 MB）。它和网页版一样需要一个可直接下载的 zip。

为什么必须用脚本而不是手工压缩：
    1. `target/release/` 里躺着一个 22 MB 的 `shuangpin_practice_lib.dll`，
       那是 `crate-type` 里 `cdylib` 的副产物（为将来可能的移动端准备），
       **桌面运行完全不需要**。手工拖拽极易把它一起压进去，
       分发包会从 3.5 MB 变成 26 MB，而且没人会注意到。
    2. 真正需要的是**恰好两个文件**：exe + WebView2Loader.dll（MinGW 构建下
       加载器只能动态链接）。少一个 DLL 用户就会看到「找不到 WebView2Loader.dll」。
    3. 文件名要是产品名（双拼练习.exe），而不是 cargo 的包名。

用法：
    python tauri/tools/make_package.py            # 输出到 dist/
    python tauri/tools/make_package.py --out DIR  # 指定输出目录

前置条件：先构建。即
    node tauri/tools/prepare-frontend.mjs
    cd tauri/src-tauri && cargo build --release
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

# tauri/tools/ → 上两级是仓库根
TAURI_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = TAURI_DIR.parent
RELEASE_DIR = TAURI_DIR / "src-tauri" / "target" / "release"

# 分发包里**恰好**要有的文件：目标名 -> 源文件名
# 加文件前先想清楚：它是不是运行时真的需要？
PAYLOAD = {
    "双拼练习.exe": "shuangpin-practice.exe",
    "WebView2Loader.dll": "WebView2Loader.dll",
}

# 明确列出**不能**进包的东西，并在构建时断言它们不在。
# 这比「只挑需要的」更保险：将来 cargo 多产出什么，也会被这里挡住。
FORBIDDEN = ["shuangpin_practice_lib.dll", "shuangpin_practice_lib.dll.lib"]

USAGE_TXT = """双拼练习 · 小鹤双拼打字练习器
================================

怎么用
------
双击「双拼练习.exe」即可，不用安装。
两个文件必须放在**同一个文件夹**里（WebView2Loader.dll 是运行库，
单独把 exe 拷走会提示找不到它）。

关于 WebView2
-------------
本应用使用 Windows 自带的 WebView2 渲染界面，自己不携带浏览器内核 ——
这也是它只有 3.5 MB 的原因。

绝大多数电脑已经装好了：
  · Windows 11 全系预装
  · Windows 10（1803 及以上）随 Edge 一起提供

如果双击后提示缺少 WebView2，装一次即可（联网）：
  https://developer.microsoft.com/microsoft-edge/webview2/

数据存在哪
----------
练习记录保存在本机（WebView2 的本地存储），不会上传到任何服务器。
清除浏览器数据 / 应用数据会导致记录丢失，建议定期在「设置」页导出备份。

换版本请注意
------------
桌面版、网页版各自独立保存记录，互相看不到。
换用时先在旧版本「设置」页导出数据，再到新版本导入。

授权
----
MIT License © 2026 kungco
https://github.com/kungco/shuangpin-practice
"""


def read_version() -> str:
    """从根 package.json 读版本号，保证与仓库其它地方一致。"""
    pkg = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def main() -> int:
    ap = argparse.ArgumentParser(description="打包 Tauri 桌面版分发包")
    ap.add_argument("--out", default=str(REPO_ROOT / "dist"), help="输出目录（默认 dist/）")
    args = ap.parse_args()

    if not RELEASE_DIR.is_dir():
        print(f"❌ 找不到构建产物目录：{RELEASE_DIR}")
        print("   请先构建：")
        print("     node tauri/tools/prepare-frontend.mjs")
        print("     cd tauri/src-tauri && cargo build --release")
        return 1

    # 先确认需要的文件都在，再动手 —— 免得压出一个残缺的包
    missing = [src for src in PAYLOAD.values() if not (RELEASE_DIR / src).is_file()]
    if missing:
        print(f"❌ 构建产物不完整，缺少：{', '.join(missing)}")
        print(f"   目录：{RELEASE_DIR}")
        print("   请先跑 `cargo build --release`（见 tauri/README.md）。")
        return 1

    # 断言那些「绝不能进包」的文件确实没被列进来
    for bad in FORBIDDEN:
        if bad in PAYLOAD.values():
            print(f"❌ 打包清单里混入了不该分发的文件：{bad}")
            return 1

    version = read_version()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"ShuangpinPractice-{version}-win64.zip"
    out_zip = out_dir / name

    total = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, srcname in PAYLOAD.items():
            src = RELEASE_DIR / srcname
            zf.write(src, arcname)
            total += src.stat().st_size
        # 使用说明：UTF-8 with BOM —— 老版本记事本没 BOM 会按 GBK 解码而乱码
        zf.writestr("使用说明.txt", USAGE_TXT.encode("utf-8-sig"))

    # 压缩后如果接近 22 MB，说明那个 cdylib 混进来了
    size = out_zip.stat().st_size
    if size > 8 * 1024 * 1024:
        print(f"⚠️  压缩包异常大（{size / 1048576:.1f} MB），检查是否混入了 "
              f"shuangpin_practice_lib.dll 之类的构建副产物")

    print(f"✅ 已生成 {out_zip}")
    print(f"   版本：{version}")
    print(f"   文件数：{len(PAYLOAD) + 1}（含使用说明）")
    print(f"   原始大小：{total / 1024:.1f} KB")
    print(f"   压缩包：{size / 1024:.1f} KB")
    print()
    print("   包内清单：")
    for arcname, srcname in PAYLOAD.items():
        mb = (RELEASE_DIR / srcname).stat().st_size / 1048576
        print(f"     {arcname}  ({mb:.3f} MB)")
    print("     使用说明.txt")
    print()
    print("   注意：WebView2Loader.dll 必须与 exe 放在同一目录（已在说明里写明）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
