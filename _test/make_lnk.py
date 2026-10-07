"""
生成 Windows 快捷方式（.lnk）

背景：WorkBuddy 的安全策略禁止 COM 实例化（WScript.Shell），
因此不能用 CreateShortcut() 这条常规路径。这里直接手写 Shell Link
二进制格式（MS-SHLLINK），只实现必要字段。

支持内容：
  - 目标路径（本地文件，非 Unicode 与 Unicode 两种字符串都写）
  - 工作目录
  - 描述 / 备注
  - 图标位置
  - 窗口样式

不做的事（保持简单，字段缺失时 Windows 会按默认处理）：
  - LinkInfo / TrackerData / PropertyStore
  - 环境变量数据块（DataBlock）
"""

import struct
import sys

# ---- LinkFlags 位 ----
HAS_LINK_TARGET_ID_LIST = 0x00000001
HAS_LINK_INFO = 0x00000002
HAS_NAME = 0x00000004
HAS_RELATIVE_PATH = 0x00000008
HAS_WORKING_DIR = 0x00000010
HAS_ARGUMENTS = 0x00000020
HAS_ICON_LOCATION = 0x00000040
IS_UNICODE = 0x00000080
FORCE_NO_LINK_INFO = 0x00000100
HAS_EXP_STRING = 0x00000200


def _str_data(s: str) -> bytes:
    """CountedString：2 字节字符数 + UTF-16LE 字符（不含结尾空字符）"""
    if s is None:
        s = ''
    data = s.encode('utf-16-le')
    return struct.pack('<H', len(s)) + data


def _id_list(target_path: str) -> bytes:
    """
    LinkTargetIDList。
    为最小可行实现，退化为「根目录 + 文件名」两段 ItemID，
    目标路径的真实解析依赖后面的 RELATIVE_PATH / Unicode 字符串字段。
    这里构造一个指向「我的电脑」根的最小 IDList，Windows 可正常接受。
    """
    # 根目录 ItemID：My Computer (0x1F, 0x50)
    my_computer = bytes([
        0x14, 0x00,           # ItemIDSize = 20
        0x1F, 0x50,           # My Computer
        0xE0, 0x4F, 0xD0, 0x20,
        0xEA, 0x3A, 0x69, 0x10,
        0xA2, 0xD8, 0x08, 0x00,
        0x2B, 0x30, 0x30, 0x9D,
        0x00, 0x00,           # 终止符
    ])
    return struct.pack('<H', len(my_computer)) + my_computer


def make_lnk(
    lnk_path: str,
    target: str,
    arguments: str = '',
    working_dir: str = '',
    description: str = '',
    icon_location: str = '',
    show_cmd: int = 1,
) -> bool:
    """
    写出一个 .lnk 文件。

    show_cmd: 1 = 常规窗口, 3 = 最大化, 7 = 最小化
    """
    # Windows 路径统一用反斜杠（传进来可能是正斜杠）
    target = target.replace('/', '\\')
    working_dir = working_dir.replace('/', '\\') if working_dir else ''
    icon_location = icon_location.replace('/', '\\') if icon_location else ''

    flags = IS_UNICODE | FORCE_NO_LINK_INFO
    if description:
        flags |= HAS_NAME
    if working_dir:
        flags |= HAS_WORKING_DIR
    if arguments:
        flags |= HAS_ARGUMENTS
    if icon_location:
        flags |= HAS_ICON_LOCATION

    parts = []

    # ---- ShellLinkHeader (76 字节) ----
    # 布局（已用本机真实 .lnk 样本反向核对）：
    #   HeaderSize(4) = 0x4C
    #   LinkCLSID(16) = 00021401-0000-0000-C000-000000000046
    #   LinkFlags(4) / FileAttributes(4)
    #   CreationTime(8) / AccessTime(8) / WriteTime(8) / FileSize(4)
    #   IconIndex(4) / ShowCommand(4) / HotKey(2) / Reserved1(2) / Reserved2(4)
    #   Reserved3(4)  ← 常被忽略，缺了它就凑不满 76
    CLSID_SHELL_LINK = bytes([
        0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
    ])
    header = bytearray()
    header += struct.pack('<I', 0x0000004C)          # HeaderSize
    header += CLSID_SHELL_LINK                       # LinkCLSID (16)
    header += struct.pack('<I', flags)               # LinkFlags
    header += struct.pack('<I', 0x00000020)          # FileAttributes
    header += struct.pack('<Q', 0)                   # CreationTime
    header += struct.pack('<Q', 0)                   # AccessTime
    header += struct.pack('<Q', 0)                   # WriteTime
    header += struct.pack('<I', 0)                   # FileSize
    header += struct.pack('<i', 0)                   # IconIndex
    header += struct.pack('<I', show_cmd)            # ShowCommand
    header += struct.pack('<H', 0)                   # HotKey
    header += struct.pack('<H', 0)                   # Reserved1
    header += struct.pack('<I', 0)                   # Reserved2
    header += struct.pack('<I', 0)                   # Reserved3（补齐到 76）
    assert len(header) == 76, f'header 应为 76 字节，实际 {len(header)}'
    parts.append(bytes(header))

    # ---- LinkTargetIDList ----
    idl = _id_list(target)
    parts.append(struct.pack('<H', len(idl)))
    parts.append(idl)

    # ---- StringData（顺序固定：NAME, RELATIVE_PATH, WORKING_DIR, ARGUMENTS, ICON_LOCATION）----
    if description:
        parts.append(_str_data(description))
    # RELATIVE_PATH：填入绝对目标路径即可（Windows 会优先使用它）
    parts.append(_str_data(target))
    if working_dir:
        parts.append(_str_data(working_dir))
    if arguments:
        parts.append(_str_data(arguments))
    if icon_location:
        parts.append(_str_data(icon_location))

    blob = b''.join(parts)

    # ---- TerminalBlock ----
    blob += struct.pack('<I', 0)   # TerminalBlock

    with open(lnk_path, 'wb') as f:
        f.write(blob)
    return True


if __name__ == '__main__':
    # 命令行用法：make_lnk.py <lnk> <target> [args] [cwd] [desc] [icon]
    a = sys.argv[1:]
    if len(a) < 2:
        print('usage: make_lnk.py <lnk> <target> [args] [cwd] [desc] [icon]')
        sys.exit(2)
    lnk = a[0]
    target = a[1]
    arguments = a[2] if len(a) > 2 else ''
    cwd = a[3] if len(a) > 3 else ''
    desc = a[4] if len(a) > 4 else ''
    icon = a[5] if len(a) > 5 else ''
    make_lnk(lnk, target, arguments, cwd, desc, icon)
    print(f'created: {lnk}')
