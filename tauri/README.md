# 双拼练习 · Tauri 外壳

用**系统自带的 WebView2** 代替 Electron 的 Chromium，把同一个静态站点包成桌面应用。
应用本体仍然是仓库根那份**零依赖、零构建**的 `index.html + assets/ + src/`，
这里只负责打包。

从 v1.6.1 起，正式下载由 `.github/workflows/desktop-release.yml` 在 Windows MSVC 环境构建。
通过前端自检后，工作流验证 exe 版本号、进程与 WebView2 启动，再以
`python tauri/tools/make_package.py --static-loader` 生成 exe + 使用说明的 zip 和 SHA-256 文件。
下方体积数据是 v1.6.0 的 MinGW 实测，MinGW 自行构建仍使用默认打包命令并附带 DLL。

> **这是当前的桌面版主力。** 早先的 Electron 版（`desktop/`）从 v1.6.0 之后
> 不再作为下载提供 —— 同一份代码用 Tauri 打包只要 1.6 MB，Electron 是 65 MB。
> Electron 工程保留在仓库里作为兜底，也留着一份「在 Electron 里抠体积」的实测记录。

## 实测结果

已在本机构建并跑通（Windows / Rust 1.99.0 / `x86_64-pc-windows-gnu` / MinGW-w64 GCC 16.2.0）：

| | Electron 版（`desktop/`） | Tauri 版（本目录） |
| --- | --- | --- |
| 主程序 | `双拼练习.exe` **64.572 MB** | `shuangpin-practice.exe` **3.357 MB** |
| 附带运行时 | 解包后 230 MB（自带 Chromium） | `WebView2Loader.dll` **0.153 MB** |
| **分发合计** | **64.572 MB** | **3.511 MB** |
| 比值 | — | **小 18.4 倍（−94.6%）** |
| 运行时内存 | 数十 MB 起 | 约 33 MB（实测进程 RSS） |

> 冒烟测试：运行后进程存活，并拉起 **12 个 `msedgewebview2` 子进程** ——
> 说明 WebView2 运行时确实加载、页面确实在渲染。
> 构建环境没有可交互桌面，所以「用眼睛看窗口里的内容」这一步做不了 ——
> 已由作者在实机上双击运行确认，界面与功能均正常。

## ⚠️ 前提：WebView2 运行时

**「几 MB」只在复用系统已有的 WebView2 时成立。** 目标机器上没有它时，
得把运行时一起带上，体积优势就没了。官方给的三档（来自 `tauri-utils` 源码注释）：

| `webviewInstallMode` | 安装包增重 | 适用场景 |
| --- | --- | --- |
| `{ "type": "downloadBootstrapper" }` ← **本工程选用** | 几乎不增加 | 安装时联网下载。**绝大多数目标机器本来就有**，不会触发 |
| `{ "type": "embedBootstrapper" }` | **约 1.8 MB** | 同上，但引导程序内嵌，安装时不必先联网取它 |
| `{ "type": "offlineInstaller" }` | **约 127 MB** | 目标机器**没有 WebView2 且不能联网** |
| `{ "type": "fixedRuntime" }` | **约 180 MB** | 要锁定某个特定 WebView2 版本 |

**WebView2 的普及情况**：Windows 11 全系预装；Windows 10 从 1803 起随 Edge 提供，
绝大多数已更新的机器都有（本开发机上就有：`EdgeWebView\Application\154.0.4258.62`）。

结论：
- 面向**普通 Windows 用户**（装过 Edge / Win11）→ 用默认的 `downloadBootstrapper`，
  分发就是 **3.5 MB**，成立。
- 要覆盖**没有 WebView2 又不能联网**的干净系统 → 安装包涨到 100 MB 以上，
  **这时 Tauri 的体积优势基本消失**，得重新权衡。

## 怎么构建

需要两样**一次性的环境准备**（与项目无关）：

1. **Rust 工具链** —— 从 <https://rustup.rs> 装（装到用户目录，不需要管理员）。
2. **C 链接器**，二选一：
   - **MSVC**（Tauri 官方推荐）：装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，
     勾选「使用 C++ 的桌面开发」。**需要管理员权限、下载数 GB。**
     好处是 WebView2 加载器会**静态链进 exe**，产物是**真正的单文件**。
   - **MinGW-w64**（本机采用的方案，免管理员）：装 MSYS2 后
     `pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-binutils`。
     代价是 WebView2 加载器只能**动态链接**，需要随 exe 一起带上
     `WebView2Loader.dll`（0.15 MB）—— 见下方「单文件 vs 两个文件」。

环境就绪后：

```bash
cd tauri
npm install              # 只装 @tauri-apps/cli
npm run build            # 出 NSIS 安装包
npm run build:portable   # 只要裸 exe
npm run dev              # 开发模式
```

也可以完全绕开 npm CLI，直接用 cargo（本机就是这么构建的），
再打成发布用的 zip：

```bash
node tauri/tools/prepare-frontend.mjs            # 1. 备好 tauri/dist
cd tauri/src-tauri && cargo build --release      # 2. 编译 → target/release/
python tauri/tools/make_package.py               # 3. 打包 → dist/ShuangpinPractice-<版本>-win64.zip
```

第 3 步**不要手工压缩**。`target/release/` 里躺着一个 22 MB 的
`shuangpin_practice_lib.dll`（`crate-type` 里 `cdylib` 的副产物，桌面运行不需要），
手工拖拽很容易把它一起压进去，包从 1.6 MB 变成 26 MB 而没人会注意。
`make_package.py` 精确列出**恰好两个文件**（exe + `WebView2Loader.dll`），
并在压缩包异常大时主动告警。

## 构建时踩到的两个坑

都是**照着文档写、实际编译才发现**的问题。记在这里，免得下次重踩。

### 1. `webviewInstallMode` 必须写成对象

文档里给的是字符串写法 `"webviewInstallMode": "downloadBootstrapper"`，
但实际编译报：

```
invalid type: string "downloadBootstrapper", expected internally tagged enum WebviewInstallMode
```

因为它在 `tauri-utils` 里是 `#[serde(tag = "type", rename_all = "camelCase")]`
的**内部标记枚举**，正确写法是 `{ "type": "downloadBootstrapper", "silent": true }`。

### 2. `indexmap` 的 `has_std` 探测失败（已修，见 Cargo.toml 注释）

`indexmap 1.x` 用 autocfg **编译探测** sysroot 里有没有 std 来决定 emit `has_std`，
而这个 cfg 决定 `IndexMap<K, V, S = RandomState>` 有没有默认类型参数。
探测失败时 `schemars 0.8.22`（tauri-build / tauri-utils 的依赖）编译不过：

```
error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied
```

本机的 rustup `x86_64-pc-windows-gnu` 就会失败：`<sysroot>/lib` 下只有 `rustlib/`，
`libstd-*.rlib` 在 `lib/rustlib/<target>/lib/`，探测拿不到。

修法是显式打开 indexmap 的 `std` feature（作者留的后门：开了就不探测），
写在 `src-tauri/Cargo.toml` 的 `[build-dependencies]` 里，附了完整说明。
**MSVC 环境下未必需要这一条**，但它无害（正常环境本来也会探测出 `has_std=true`）。

## 单文件 vs 两个文件

用 **MSVC** 构建 → WebView2 加载器静态链入，一个 exe 文件搞定。

用 **MinGW（GNU target）** 构建 → 加载器只能动态链接，需要两个文件：

```
shuangpin-practice.exe    3.357 MB
WebView2Loader.dll        0.153 MB
```

两个文件放同一目录即可，打包成 zip 分发。`npm run build` 出的 NSIS 安装包会自动带上。

> `target/release/` 里还有个 **22 MB 的 `shuangpin_practice_lib.dll`** ——
> 那是 `crate-type` 里 `cdylib` 的副产物（为将来可能的移动端准备），
> **桌面运行不需要它，不要跟着分发**。

## 目录说明

```
tauri/
├── package.json                   npm 脚本（prepare / dev / build）
├── tools/
│   ├── prepare-frontend.mjs       把仓库根的静态站点复制到 tauri/dist/
│   ├── make_package.py            打包发布用的 zip（exe + DLL + 使用说明）
│   └── make_icons.py              生成 PNG + ICO 图标（纯标准库，无需 Pillow）
└── src-tauri/                     Rust 工程
    ├── Cargo.toml                 依赖、体积优化、indexmap 修正（见内注释）
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

## 为什么这个应用特别适合换壳

应用本体是零依赖静态站点，Electron 壳只干一件事：用真实 origin 提供文件
（`file://` 下 ES 模块会被 CORS 拦掉）。Tauri 把这件事做成了内建能力
（`frontendDist` 自动服务在 `tauri://localhost`，本身就是安全来源）。

于是 Electron 版 `desktop/main.cjs` 里那 **169 行**（注册 `app://` 自定义协议、
路径穿越防护、沙箱崩溃降级重启）在这里**全部不需要** —— `lib.rs` 只有 8 行。

## 与 Electron 版的关系

**Tauri 版是当前的桌面版主力**，Electron 版（`desktop/`）从 v1.6.0 之后
不再作为下载提供，但工程保留在仓库里 —— 它已验证过多个版本，是最稳的兜底；
而且它那份 `build:slim` 的实测记录说明了「在 Electron 里抠体积」的天花板在哪
（裁掉 7 个用不到的运行时组件只省 8%，因为主程序一个就 180 MB）。

两者共用同一份静态站点，互不影响。

> **练习记录不互通。** localStorage 按 origin 隔离：Electron 版跑在 `app://local`，
> Tauri 版跑在 `tauri://localhost`，网页版又是另一个。三者的记录各自独立 ——
> 这与「桌面版和网页版记录互相独立」是同一回事。换版本时先「导出数据」备份、
> 再在新版本里「导入数据」即可。

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
