# 自检脚本

六个互相独立的测试套件，**只用于开发期自检，不影响应用运行**。
（应用本身零依赖，但**不能直接双击 `index.html`** —— 浏览器禁止在 `file://`
协议下加载 ES 模块，必须经由本地 HTTP 服务打开。见文末说明。）

| 脚本 | 覆盖范围 | 依赖 |
|---|---|---|
| `verify.mjs` | 双拼方案正确性、题库可拆分性、键位表完整性、边界输入、**测验出题配比**、**评分算法** | 无 |
| `engine.mjs` | 练习引擎逻辑：逐键校验、推进、统计、暂停、限时、异常输入、**考试模式无提示硬约束** | 无 |
| `storage.mjs` | **存储降级**（配额满 → 内存 → 恢复落盘）、**导入合并**、**日报与历史一致性**、**间隔重复排期（SM-2 简化版）**、设置项类型校验 | 无 |
| `a11y.mjs` | **减少动态效果**、**快捷键规范化与冲突校验**、**物理键位映射（Dvorak / AZERTY）**、**屏幕阅读器播报**、**WebAudio 音效合成与连错降音** | 无 |
| `launcher.mjs` | **启动脚本静态自检**：编码前提（BOM / CRLF / chcp 顺序）、引用的文件是否存在、标签配对、三级回退链、与服务端脚本的接口一致性、危险写法扫描 | 无 |
| `integration.mjs` | 在模拟 DOM 中加载整个应用，驱动完整交互流程（含**能力测验端到端**、**辅助功能接线层**） | `linkedom` |

> `storage.mjs` / `a11y.mjs` / `launcher.mjs` 都是「零依赖 + 毫秒级」的套件，
> 且不引入 linkedom —— 它们测的模块本身不碰 DOM（`announce` 查不到节点会安全返回，
> 音效无 WebAudio 会静默降级）。适合改对应代码时高频单跑。

另有四个**开发辅助**脚本（属于工具，非测试）：

- `serve.mjs` —— 零依赖静态服务器，给 headless Chrome / 人工预览用。**别用
  `python -m http.server` 后台跑** —— 那个进程会随父 shell 一起被回收，
  截图时可能已经死掉（表现为 `ERR_CONNECTION_REFUSED`）。
  用法：`node _test/serve.mjs [port]`（默认 8791）。
- `serve.ps1` —— 同样功能的 **PowerShell 版**，给「本机没装 Python 也没装 Node」
  的用户当兜底（PowerShell 是 Windows 自带的）。启动脚本会按
  Python → Node → PowerShell 的顺序挑一个。
  用法：`powershell -NoProfile -ExecutionPolicy Bypass -File _test/serve.ps1 -Port 8781 -Root <仓库根>`
  支持 `-SelfTest`：只跑路径解析与目录穿越防护的断言，**不起监听、不占端口**，
  方便验证这个脚本本身还能用。

  > 编码要求：本文件必须是 **UTF-8 with BOM + CRLF**。PowerShell 5.1 在没有 BOM 时
  > 会按系统 ANSI（简中环境即 GBK）解码，中文注释变成乱码后可能「吞掉」换行和引号，
  > 报错却指向完全不相干的行（典型症状：`表达式或语句中包含意外的标记"}"`）。
  > `.gitattributes` 里已声明 `*.ps1 text eol=crlf`，BOM 作为内容字节随文件一起提交。
- `shot.mjs` —— headless Chrome + CDP 截图工具，用于视觉验证。
  用法：`node _test/shot.mjs <url> <out.png> [width] [height] [script-file]`，
  可选 `script-file` 会在截图前注入执行（切视图 / 模拟按键）。
  注意两点：环境里有代理，必须带 `--no-proxy-server`；用
  `--force-device-scale-factor=2` 才能看清细节。
- `make_lnk.py` —— 手写 Shell Link（MS-SHLLINK）二进制格式生成 Windows 快捷方式。
  之所以不用 `WScript.Shell.CreateShortcut()`，是因为当前环境的安全策略禁止 COM 实例化。
  用法：

  ```bash
  python _test/make_lnk.py <目标.lnk> <目标程序> [参数] [工作目录] [描述] [图标]
  ```

下面三个是**题库体检 / 维护**脚本（同样属于工具）：

- `_audit_bank.mjs` —— 题库体检报告：规模统计、拼音映射质量、韵母键覆盖率、
  词组/短文的字覆盖闭合性、拼音重复度。**改动题库后建议跑一次**，
  它会直接指出「哪些字只在词组里出现却练不到」这类不一致。
- `dedupe_chars.mjs` —— 生成期去重工具。
- `gen_expand.mjs` —— 早期批量扩充题库的生成器（已用过，保留备查）。

## 运行

**推荐（一次装依赖，之后跑全部六套）：**

```bash
cd _test
npm ci            # 按 package-lock.json 精确还原依赖（首次或换环境时执行）
npm test          # 依次跑 verify → engine → storage → a11y → launcher → integration
```

也可以单独跑：

```bash
node _test/verify.mjs
node _test/engine.mjs
node _test/storage.mjs
node _test/a11y.mjs
node _test/launcher.mjs
node _test/integration.mjs
```

> Windows 下若 `node` 不在 PATH，可用 WorkBuddy 内置运行时：
> `"C:/Users/ASUS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" _test/verify.mjs`

### 依赖可复现性（为什么要用 `npm ci`）

`integration.mjs` 需要 `linkedom` 来模拟 DOM，其余五套**零依赖**。
为了「换个环境/换个人跑结果都一样」，`_test/` 下提交了两个文件：

| 文件 | 作用 |
|---|---|
| `package.json` | 声明依赖，**`linkedom` 写死为精确版本 `0.18.13`**（不是 `^0.18.13`） |
| `package-lock.json` | 锁定全部 20 个包的**确切版本 + 完整性哈希**（lockfileVersion 3） |

请用 **`npm ci`** 而不是 `npm install` —— 前者严格按锁文件还原、发现不一致会直接报错，
后者可能悄悄升级出不同的依赖树。只在确实要升级依赖时才用 `npm install`（并重新提交锁文件）。

仓库里**不包含** `node_modules`（见 `.gitignore`），clone 下来先 `npm ci` 即可。

### CI

`.github/workflows/tests.yml` 会在 push / PR 时用 **Node 18 / 20 / 22** 三个版本
各跑一遍六套测试：
`actions/checkout` → `setup-node` → `cd _test && npm ci` → 依次执行六个脚本。
这样「检出目录没有 linkedom、集成测试跑不起来」的情况不会再出现 ——
依赖由锁文件保证，runner 每次都是干净且一致的。

> `launcher.mjs` 在 Linux runner 上也能跑：它做的是**纯静态检查**（读字节、
> 匹配文本、校验接口约定），不依赖 Windows 运行时。真正的 `cmd.exe` 行为
> 只能在 Windows 上人眼确认 —— 这也是它被设计成静态检查的原因。

## 关于 `node_modules`

`_test/node_modules/` 里只装了 `linkedom`（含 19 个传递依赖）供 `integration.mjs` 使用，
**不进仓库**。另外三套零依赖，删掉整个目录也照样跑；只有 `integration.mjs` 需要它。

重建方式（务必用 `ci`，版本以锁文件为准）：

```bash
cd _test && npm ci
```

## `storage.mjs` 覆盖什么

存储层的坑有个共同点：**只在真实使用中才暴露**，平时的正常路径怎么点都看不出来。
这个套件把出过事故的几类行为钉死：

| 用例 | 钉住的规则 |
|---|---|
| 【1】配额满后的降级读写 | **写失败后立即读**必须还能拿到内存里的数据（旧实现读到 `null`） |
| 【2】清理后重试 | 一条写不动 ≠ 整体降级；`pruneHistory` 重试成功就不该降级 |
| 【3】空间释放后恢复 | 降级**不是单向**的；恢复过程不能丢内存里攒的数据 |
| 【4】localStorage 不可用 | 隐身模式下不抛异常，靠内存兜住，`exportAll` / `storageUsage` 仍可用 |
| 【5】跨设备同日导入 | **日报必须与历史逐项相等**（旧实现逐字段取 max 会少算） |
| 【6】daily 独有日期 | 历史里没有、只在老备份 daily 里的日期不能被重建覆盖掉 |
| 【7】重复导入幂等 | 同一份备份导三次，日报逐字段不变 |
| 【8】增量 vs 全量 | `updateDaily`（逐条累加）与 `rebuildDailyFromHistory`（全量重建）产出**完全相同**的对象 |
| 【9】SM-2 排期本体 | 阶梯 `1→3→7→16→35→75` 天、超出阶梯按 `ease` 拉长、上限 365 天；答错重置为 1 天且 `ease` 下降并触底不越界 |
| 【10】与记录联动 | 答错建立排期、答对推进间隔、再次答错**撤销**「已掌握」、连对够多且错误率低才标记掌握 |
| 【11】到期优先排序 | 到期项压过错误次数排前面；同为到期则越早到期越靠前；`dueOnly` 过滤；`reviewSummary` 不计已掌握项 |
| 【12】导入合并的调度取舍 | 排期字段取「更靠前」的一侧，连对次数不倒退 |
| 【13】设置项类型 | `shortcuts` 是对象，**不能**被标量校验强制成 `"[object Object]"`；非法枚举值回退默认 |
| 【14】存储三态命名 | `storageModeName()` 可辨识降级态；`_resetStorageState()` 能复位（否则用例之间会串味） |

测试用一个「按字节数判断」的 localStorage 桩模拟配额 —— 真实配额满不是
「setItem 永远抛」，而是取决于**这一条**的大小，所以桩里可以精确地
只打掉某一条写入，从而测出「清理老记录后重试成功」这条路径。

> 8 组用例都验证过「把旧实现注入回去会失败」：注入 bug 后【1】报 2 项、
> 【5】【6】共报 6 项未通过。

## `a11y.mjs` 覆盖什么

辅助功能的问题几乎都属于「只有在真实浏览器 + 真实键盘/读屏软件里才看得见」，
所以这个套件用**构造事件对象**的方式把规则钉死，不依赖真实设备：

| 用例 | 钉住的规则 |
|---|---|
| 【1】减少动态效果 | 媒体查询读取、变化监听、`html.reduce-motion` 类名切换 |
| 【2】快捷键规范化 | `Tab`→`tab`、**空格必须在 `trim()` 之前判断**（`' '` 经 trim 会变成 `''`，再也认不出是空格）、`Esc`/`Spacebar` 等别名 |
| 【3】合并与校验 | 空串/`null` 是**显式解绑**（不回落默认）；出现重复键或保留键时**整体退回默认**，不留半坏状态 |
| 【4】命中判定 | **未绑定（`''`）的快捷键永远不命中** —— 否则「解绑 Tab」会变成「Tab 到处触发」 |
| 【5】物理键位 | Dvorak 下按物理 D 键（打出 `e`）必须取 `d`；AZERTY 同理；拿不到 `code` 时才回退到 `key` |
| 【6】屏幕阅读器播报 | polite / assertive 两个区域**互不污染**；重复文本仍重新写入（先清空再写，否则读屏软件不复读） |
| 【7】音效合成 | 无 WebAudio 时**全部静默降级不抛异常**；装上 AudioContext 桩后验证真的合成了振荡器、三角波/正弦波选型、完成音是 3 个音、**连错降音且音量有下限**、答对一次清零连错计数、`suspended` 时调用 `resume()` |

## `launcher.mjs` 覆盖什么

「用户双击没反应」的代价很高，而沙箱/CI 里都不能真的派生 `cmd.exe` 去跑一遍。
于是改为**静态自检**，把「跑起来才知道」的那几类问题提前钉死：

| 分组 | 钉住的规则 |
|---|---|
| A. 编码前提 | `.bat` **不能带 BOM**（带 BOM 时部分 Windows 会把首行当非法命令、直接不执行）；必须全 CRLF；`chcp 65001` 必须出现在第一处中文**之前** |
| B. 引用的文件 | 脚本里提到的 `serve.mjs` / `serve.ps1` / `index.html` 必须真实存在 |
| C. 标签配对 | 每个 `goto` / `call` 都有对应标签（错一个就是死循环或跳到文件尾静默结束） |
| D. 回退链 | 三级齐全且**顺序为 Python → Node → PowerShell**；三者都不可用时有明确提示，不静默失败；Python 探测排除了 `WindowsApps` 占位符 |
| E. 接口一致性 | 启动脚本传的 `-Port` / `-Root` 与服务端脚本声明的参数名对得上；两边都只绑 `127.0.0.1`；`serve.ps1` 带 BOM |
| F. 安全检查 | 没有递归删除、不碰注册表、不联网下载；出错路径都有非零退出码 |

> `serve.ps1` 除了静态检查，还支持 `-SelfTest` 参数：**真跑**一遍路径解析与
> 目录穿越防护的断言（含 `%2e%2e` / `..%2f` 等 URL 编码变体、相似前缀的兄弟目录），
> 但**不起监听、不占端口**。这样即使无法在沙箱里起服务，防护逻辑也是被真正执行验证过的。

## 测试环境的两处「降级垫片」（不是应用 bug）

`integration.mjs` 会为 `linkedom` 补几个浏览器行为，避免把测试框架的缺陷误判成应用缺陷：

1. **`select.value` / `input.value` 可写** —— linkedom 把它们实现成了只读 getter。
2. **事件监听器捕获** —— linkedom 把监听器注册表存在模块私有的 WeakMap 中，
   外部读不到，测试无法触发 `addEventListener` 绑定的处理器；这里在元素层面
   额外记录一份到 `el.__handlers`，供测试派发事件。

另外，headless 环境里模拟按键是「瞬时」跑完的（真实浏览器中一次 20 题的练习
至少需要数秒），因此用时可能不足 1 秒。此时引擎不给出速度值（分母过小会把速度
放大到失真），集成测试对此只断言「有用时记录」与「速度字段可用」。

## 怎么打开应用（重要）

浏览器出于安全策略，**禁止在 `file://` 协议下加载 ES 模块**，所以双击
`index.html` 会白屏。三个可选方式：

1. **Windows**：双击仓库根目录的 `启动双拼练习.bat` —— 它会自动挑一个空闲端口
   起服务并打开浏览器。用完关掉那个最小化的服务窗口即可。
   **不需要预先安装任何东西**：脚本会按 Python → Node.js → PowerShell 的顺序
   挑一个可用的（PowerShell 是 Windows 自带的，所以一定能跑起来）。
2. **手动起服务**：任选一种 ——
   - `python -m http.server 8781`（macOS / Linux 用 `python3`）
   - `node _test/serve.mjs 8781`
   - `powershell -NoProfile -ExecutionPolicy Bypass -File _test/serve.ps1 -Port 8781`

   然后访问 `http://127.0.0.1:8781/`。
3. 用 VS Code 的 Live Server 插件打开 `index.html`。

> 桌面快捷方式不属于仓库内容 —— 本机那个 `.lnk` 是用 `make_lnk.py` 生成的，
> 别人 clone 下来没有。想在自己机器上也弄一个，跑一次该脚本即可（见上文说明）。

若不小心用 `file://` 打开了，页面会在 0.7 秒后弹出提示，告知上面这几种方式，
不会让你面对一片白屏。

## 本机额外验证

建议再用真实浏览器走一遍：开始练习 → 故意按错 → 暂停/继续
→ 看统计曲线 → 错题复习。集成测试只能覆盖到「接线」层面，视觉与交互手感需要人眼确认。

本轮新增的三块，人手确认清单：

- **音效**：设置页打开「按键音效」应立即听到一声轻响（同时完成 AudioContext 解锁），
  之后答对是轻脆短音、答错是低沉短音、完成一轮是三音上行。
- **减少动态效果**：设置页切到「减少动态效果」后，故意按错应看到**静态描边**而不是抖动；
  在系统里改「显示动画」也应被跟随（设置项为「跟随系统」时）。
- **快捷键改键**：点设置页的按键 → 显示「按下新键…」→ 按新键生效；
  按 `Delete` 解绑、按 `Esc` 取消。若把「看答案」解绑，练习时 `Tab` 应恢复成
  浏览器原生的焦点切换，不再是「看答案」。
- **便携启动**：把 `python` 从 PATH 里临时去掉（或改个名）再双击 `.bat`，
  应当仍能启动（回退到 Node 或 PowerShell）。
