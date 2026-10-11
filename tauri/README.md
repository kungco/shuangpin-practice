# 双拼练习 · Tauri 外壳

用**系统自带的 WebView2** 代替 Electron 的 Chromium，把同一个静态站点包成桌面应用。
应用本体仍然是仓库根那份**零依赖、零构建**的 `index.html + assets/ + src/`，
这里只负责打包。

> ⚠️ **这个外壳尚未实际构建验证过。** 本目录的 Rust 源码、配置与图标都写好了、
> 配置也通过了 JSON 校验，但构建这台机器上没有 Rust 工具链（见下方「怎么构建」）。
> 首次构建可能会暴露编译或配置问题。

## 为什么要它

Electron 版解包 **230 MB**，其中主程序一个就 **180 MB** —— Chromium 核心是静态链接进去的，
删不掉。压缩后的 `.exe` 是 **64.6 MB**。Tauri 复用系统已有的 WebView2，
所以自己**不带浏览器内核**，产物量级完全不同。

本应用特别适合这种换法：它是纯静态站点，Electron 壳只干一件事 ——
用真实 origin 提供文件（因为 `file://` 下 ES 模块会被 CORS 拦掉）。
Tauri 把这件事做成了内建能力（`build.frontendDist`），
于是 Electron 版那 169 行 `main.cjs`（自定义协议、路径穿越防护、沙箱降级重启）
在这里全部消失，只剩 8 行 `lib.rs`。

## ⚠️ 关键前提：WebView2 运行时

**「几 MB」这个数字只在复用系统 WebView2 的前提下成立。** 这是上一轮我说得太干脆的地方，
这里讲清楚：

| `webviewInstallMode` | 安装包会变大多少 | 适用场景 |
| --- | --- | --- |
| `downloadBootstrapper`（本工程选用，也是默认） | 几乎不增加 | 安装时联网下载 WebView2。**绝大多数目标机器本来就有**，实际不会触发下载 |
| `embedBootstrapper` | 约 2 MB | 同上，但引导程序内嵌，安装时不需先联网取引导程序 |
| `offlineInstaller` | **约 130 MB** | 目标机器**可能没有 WebView2 且不能联网**时 |
| `fixedRuntime` | **约 180 MB** | 需要锁定某个特定 WebView2 版本时（等于自带一份） |

（上表的量级是公开资料里的常见值，**不是在这里实测的** —— 本机没有工具链，
无法构建来量。真正做发布前建议自己测一遍。）

**WebView2 在目标机器上的普及情况**：Windows 11 全系预装；Windows 10 从 1803 起
随 Edge 一起提供，绝大多数已更新的机器都有。这台开发机上就装有
（`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\154.0.4258.62`）。

所以结论是：
- 面向**普通 Windows 用户**（装过 Edge / Win11）→ `downloadBootstrapper`，
  下载体积就是几 MB 量级，成立。
- 需要**离线安装包**或要覆盖老旧的干净系统 → 安装包会涨到上百 MB，
  **这时 Tauri 的体积优势就基本没了**，得重新权衡。

## 怎么构建

需要两样东西（都是**一次性的环境准备**，与项目无关）：

1. **Rust 工具链** —— 从 <https://rustup.rs> 装（安装到用户目录，不需要管理员）。
2. **MSVC 生成工具 + Windows SDK** —— 由
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   提供，勾选「使用 C++ 的桌面开发」。**这一步需要管理员权限、下载数 GB。**
   （也可以用 `x86_64-pc-windows-gnu` + MinGW 绕开 MSVC，但 Tauri 官方主推 MSVC，
   gnu 目标在资源编译等环节偶有问题，不建议新手走。）

环境就绪后：

```bash
cd tauri
npm install          # 只装 @tauri-apps/cli
npm run build        # 出 NSIS 安装包（bundle.targets 里配的）
npm run build:portable   # 只要一个裸 .exe（等价于 Electron 版的 portable）
npm run dev          # 开发模式，改代码即时生效
```

产物位置：
- 裸 exe：`src-tauri/target/release/双拼练习.exe`
- 安装包：`src-tauri/target/release/bundle/nsis/`

## 目录说明

```
tauri/
├── package.json                   npm 脚本（prepare / dev / build）
├── tools/
│   ├── prepare-frontend.mjs       把仓库根的静态站点复制到 tauri/dist/
│   └── make_icons.py              生成 PNG + ICO 图标（纯标准库，无需 Pillow）
└── src-tauri/                     Rust 工程
    ├── Cargo.toml                 依赖与发布版体积优化（lto / strip / opt-level="s"）
    ├── build.rs                   tauri_build::build()，固定内容
    ├── tauri.conf.json            窗口、打包、WebView2 安装模式
    ├── capabilities/default.json  权限（只留 core:default，本应用不调 Rust）
    ├── icons/                     图标（由 make_icons.py 生成）
    └── src/
        ├── main.rs                桌面入口，只调 lib 的 run()
        └── lib.rs                 全部 Rust 代码（8 行）
```

### 为什么 `dist/` 是复制出来的，不直接指向仓库根

仓库根还躺着 `_test/`、`desktop/`、`tauri/`、`docs/`、`.git/`，
其中 `desktop/node_modules` 就有几百 MB。`frontendDist` 指向仓库根等于把这些
全塞进应用包。`tools/prepare-frontend.mjs` 只挑**运行时真正需要**的三样
（`index.html`、`assets/`、`src/`，合计约 940 KB），
口径与网页版打包脚本 `_test/tools/make_web_package.py` 一致。

## 与 Electron 版的关系

两者**并存**，共用同一份静态站点，互不影响：

| | Electron 版（`desktop/`） | Tauri 版（`tauri/`） |
| --- | --- | --- |
| 内核 | 自带 Chromium | 系统 WebView2 |
| 体积 | 64.6 MB（压缩后） | 量级小得多（未实测） |
| 构建环境 | 只需 Node | 需要 Rust + MSVC 生成工具 |
| 成熟度 | 已发布多版、验证过 | 未构建验证 |

> **练习记录不互通。** localStorage 是按 origin 隔离的：
> Electron 版跑在 `app://local`，Tauri 版跑在 `tauri://localhost`，网页版又是另一个。
> 三者的记录各自独立 —— 这与「桌面版和网页版记录互相独立」是同一回事，
> 属于预期行为。换用哪个版本，先用「导出数据」备份、再在新版本里「导入数据」即可。

## 图标

`tools/make_icons.py` 用 Python 标准库手写 PNG 与 ICO（环境里没有 Pillow，
而 Tauri 打包 Windows 版**必须有 `.ico`**）。设计是深蓝圆角方块 + 两个并排的白色按键
—— 双拼的核心就是一个音节按两个键。

改了设计就重跑：

```bash
python tools/make_icons.py
```

生成 `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.png` 与
含 16/32/48/64/128/256 六档的 `icon.ico`。
