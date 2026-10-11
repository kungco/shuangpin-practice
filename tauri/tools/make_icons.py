#!/usr/bin/env python3
"""生成 Tauri 打包所需的图标（PNG + ICO）。

为什么自己写：环境里没有 Pillow，而 Tauri 的 `bundle.icon` 在 Windows 上
**必须有 .ico**，否则 `tauri build` 直接失败。这里用标准库手写 PNG 与 ICO ——
两个格式都很简单，不值得为它引入依赖。

图标设计：深蓝圆角方块 + 两个并排的白色按键 —— 双拼的核心就是「一个音节按两个键」。

用法：python tauri/tools/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"

# 超采样倍数：先按 4 倍画再缩，得到抗锯齿边缘（不做这一步的话圆角会有锯齿）
SS = 4

BG_TOP = (79, 124, 247)      # #4f7cf7
BG_BOTTOM = (47, 91, 216)    # #2f5bd8
KEY_FILL = (255, 255, 255)
KEY_FILL_DIM = (214, 226, 255)


def rounded_rect_cov(x: float, y: float, x0: float, y0: float,
                     x1: float, y1: float, r: float) -> bool:
    """点 (x, y) 是否落在圆角矩形内（坐标均为 0..1 的归一化值）。

    做法：把点**夹到**内部那个「核心矩形」（四边各内缩 r），再判断它到
    夹取后位置的距离是否 ≤ r。核心矩形内的点距离恒为 0（必中），
    四个角则退化成半径 r 的圆弧 —— 一步到位，不用分象限讨论。

    （最初按「逐个角判断象限」写，逻辑绕且写错了：圆角方向反了，
      画出来是几个四分之一圆。clamp 写法既短又不容易错。）
    """
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def render(size: int) -> bytes:
    """渲染一张 size×size 的 RGBA 图，返回逐行像素（未压缩的原始数据）。"""
    n = size * SS
    # 先在高分辨率下算覆盖率
    hi = bytearray(n * n * 4)
    for py in range(n):
        y = (py + 0.5) / n
        for px in range(n):
            x = (px + 0.5) / n
            i = (py * n + px) * 4

            # 背景圆角方块
            if not rounded_rect_cov(x, y, 0.04, 0.04, 0.96, 0.96, 0.21):
                continue
            t = (y - 0.04) / 0.92
            r = lerp(BG_TOP[0], BG_BOTTOM[0], t)
            g = lerp(BG_TOP[1], BG_BOTTOM[1], t)
            b = lerp(BG_TOP[2], BG_BOTTOM[2], t)

            # 两个并排的按键（双拼 = 一个音节两键）
            if rounded_rect_cov(x, y, 0.175, 0.30, 0.455, 0.70, 0.055):
                r, g, b = KEY_FILL
            elif rounded_rect_cov(x, y, 0.545, 0.30, 0.825, 0.70, 0.055):
                r, g, b = KEY_FILL_DIM

            hi[i] = r
            hi[i + 1] = g
            hi[i + 2] = b
            hi[i + 3] = 255

    # 降采样（盒式平均），得到抗锯齿结果
    out = bytearray(size * size * 4)
    k = SS * SS
    for y in range(size):
        for x in range(size):
            ar = ag = ab = aa = 0
            for dy in range(SS):
                row = ((y * SS + dy) * n + x * SS) * 4
                for dx in range(SS):
                    p = row + dx * 4
                    a = hi[p + 3]
                    # 按 alpha 预乘再平均，避免透明边缘出现黑边
                    ar += hi[p] * a
                    ag += hi[p + 1] * a
                    ab += hi[p + 2] * a
                    aa += a
            o = (y * size + x) * 4
            if aa:
                out[o] = ar // aa
                out[o + 1] = ag // aa
                out[o + 2] = ab // aa
            out[o + 3] = aa // k
    return bytes(out)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def to_png(size: int, rgba: bytes) -> bytes:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)                      # 每行的 filter 字节：0 = None
        raw += rgba[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def to_ico(images: list[tuple[int, bytes]]) -> bytes:
    """把多张 PNG 塞进一个 ICO。

    Vista 以后的 Windows 支持 ICO 条目直接用 PNG 编码，所以这里不写 BMP。
    注意：ICO 目录里宽高为 256 要用 0 表示（一个字节装不下 256）。
    """
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = b""
    offset = 6 + 16 * len(images)
    blobs = b""
    for size, png in images:
        w = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    return header + entries + blobs


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 每个尺寸只渲染一次，PNG 与 ICO 复用同一份结果
    cache: dict[int, bytes] = {}

    def png_for(size: int) -> bytes:
        if size not in cache:
            cache[size] = to_png(size, render(size))
        return cache[size]

    png_files = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in png_files.items():
        (OUT_DIR / name).write_bytes(png_for(size))
        print(f"  {name}  ({size}×{size}, {(OUT_DIR / name).stat().st_size} 字节)")

    # ICO 里放常见的那几档
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico = to_ico([(s, png_for(s)) for s in ico_sizes])
    (OUT_DIR / "icon.ico").write_bytes(ico)
    print(f"  icon.ico  (含 {', '.join(str(s) for s in ico_sizes)}，{len(ico)} 字节)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
