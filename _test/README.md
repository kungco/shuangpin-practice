# 自检脚本

七个互相独立的测试套件 + 两套需要模拟 DOM 的 + 一套真浏览器冒烟 + 一份性能基准，
**只用于开发期自检，不影响应用运行**。
（应用本身零依赖，但**不能直接双击 `index.html`** —— 浏览器禁止在 `file://`
协议下加载 ES 模块，必须经由本地 HTTP 服务打开。见文末说明。）

| 脚本 | 覆盖范围 | 依赖 |
|---|---|---|
| `verify.mjs` | 双拼方案正确性、题库可拆分性、键位表完整性、边界输入、**测验出题配比**、**评分算法**、**热力等级的颜色外通道（色盲可读）** | 无 |
| `clock.mjs` | **虚拟时钟自身的语义**（`tools/vclock.mjs`）：按 (时间, 插入序) 结算、同刻保持插入序、`advance` 途中新挂的定时器也执行、`setInterval` 重复到期、单个回调抛错不中断其它、`pendingCount` 记账 | 无 |
| `engine.mjs` | 练习引擎逻辑：逐键校验、推进、统计、暂停、限时、异常输入、**考试模式无提示硬约束**、**逐字「等提示才打对」标记（标点不算）**、**严格/非严格模式的推进与统计口径** | 无 |
| `storage.mjs` | **存储降级**（配额满 → 内存 → 恢复落盘）、**导入合并**、**日报与历史一致性**、**间隔重复排期（SM-2 简化版）**、设置项类型校验、**键位错误按模式取数与导入合并** | 无 |
| `a11y.mjs` | **减少动态效果**、**快捷键规范化与冲突校验**、**物理键位映射（Dvorak / AZERTY）**、**屏幕阅读器播报**、**WebAudio 音效合成与连错降音** | 无 |
| `launcher.mjs` | **启动脚本静态自检**：编码前提（BOM / CRLF / chcp 顺序）、引用的文件是否存在、标签配对、三级回退链、与服务端脚本的接口一致性、危险写法扫描、**模块类型声明**、**CI 工作流确实存在**、**每套自检都挂进了 `npm test` 且脚本里的文件都真实存在** | 无 |
| `training.mjs` | 提示撤除、滑动窗口与决策节奏续练、自适应档位、键位覆盖与强化上限、人工注音长度告警、词组筛选、续练、加权统计与降级、曲线均值口径、日报回落、计时同源、**测验成绩曲线只取有效分数**、500 / 5,000 题性能 | 无 |
| `integration.mjs` | 在模拟 DOM 中加载整个应用，驱动完整交互流程（含**能力测验端到端**、**辅助功能接线层**、**提示依赖度可见性**、**存储降级时的界面告知**、**词组易错归组**、**完成音效**、**测验成绩曲线**、**键位图开关**、**热力图跟随模式筛选**、**热力等级竖条根数 = 等级**、**change 重绘粒度契约**） | `linkedom` |
| `browser.mjs` | **真浏览器冒烟**（headless Chrome/Edge + CDP，补模拟 DOM 的边界）：**真实键盘事件推进引擎**、**弹窗原生焦点**（初始落点 / Tab 循环不逃逸 / Esc 关闭后归还）、**Canvas 统计真的画出了像素** 且带 `role="img"` 与随数据更新的 `aria-label`、**窄屏 390×844 无横向滚动**。找不到浏览器时**跳过**（exit 0），CI 无浏览器不会红 | Chrome/Edge |
| `bench.mjs` | **性能基准（护栏，非功能测试）**：统计「一次按键引发的 DOM 写入量」，钉死 `renderSession` 的分级重绘不被改回全量 —— 音节内推进不得重建题干。详见下方说明 | `linkedom` |

> `bench.mjs` 为什么和其他套件长得不一样：它**测的不是对错，而是性能不回退**。
> 打字场景里 `change` 是最频繁的事件（8–15 次/秒），而 `renderSession` 曾经
> 每键都重写一遍 `#prompt` 的 HTML。改成分级重绘后必须有个东西拦住
> 「下次改动又把它变回全量」——否则优化会在某次重构里静默消失。
> 指标选 **DOM 写入次数**而不是墙钟毫秒：CI 是共享 runner，毫秒抖动大，
> 写入次数是确定性的结构指标，既是优化目标本身，也不会因机器快慢给出相反结论
> （毫秒仍会打印，只作参考、不设阈值）。
>
> 它守着两条**方向相反**的约束，缺一条都会坏事：
> - 音节内推进**不得**重建题干（否则优化白做）；
> - 完成音节**必须**重绘解码区（否则就是把功能砍了冒充快）。
>
> 反向验证过：把分级粒度改回「永远全量」，前一条变红；把解码区重绘也跳过，后一条变红。


> `storage.mjs` / `a11y.mjs` / `launcher.mjs` / `clock.mjs` 都是「零依赖 + 毫秒级」
> 的套件，且不引入 linkedom —— 它们测的模块本身不碰 DOM（`announce` 查不到节点会安全返回，
> 音效无 WebAudio 会静默降级），`clock.mjs` 测的更是纯内存里的虚拟时钟。
> 适合改对应代码时高频单跑。

另有几个**开发辅助**脚本（属于工具，非测试）。

**服务器**（与自检脚本同放在 `_test/` 根目录，因为它们被启动脚本直接调用）：

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
- `probe-service.ps1` —— 探测 8781 端口上是否已有本应用的服务在跑。
- `make_lnk.py` —— 手写 Shell Link（MS-SHLLINK）二进制格式生成 Windows 快捷方式。
  之所以不用 `WScript.Shell.CreateShortcut()`，是因为当前环境的安全策略禁止 COM 实例化。
  用法：

  ```bash
  python _test/make_lnk.py <目标.lnk> <目标程序> [参数] [工作目录] [描述] [图标]
  ```

**`_test/tools/`** —— 分两类：**被测试引用的共享基座**（加粗两行）与
**构建期 / 维护期工具**。后者**不参与** `npm test`，也不被应用运行时引用。

| 工具 | 用途 |
|---|---|
| **`tools/vclock.mjs`** | **零依赖虚拟时钟**：`createVirtualClock()` 提供 `setTimeout/setInterval/clear*/now/performanceNow/advance/pendingCount/drainErrors`，语义见 `clock.mjs` 的断言。另有 `installVirtualWindow(clock)`（给不需要 DOM 的测试，如 `engine.mjs`）与 `virtualizeWindowTimers(clock, win)`（只借 `window` 上的定时器与 `Date.now`，`document` 一律不动）。单独成文件是为了让 `engine.mjs` 用得上它却不必拖进 linkedom。 |
| **`tools/harness.mjs`** | **模拟浏览器基座（共享）**：把 `integration.mjs` / `bench.mjs` 原先各自抄的那份 ~140 行 linkedom 引导代码合成一份（linkedom 缺的 canvas 桩、`value` 可写、焦点模型、`offsetParent`、监听器捕获、全局注入都在这里），并提供 `settle()` / `advance()` / `waitFor()` / `fire()` / `fireKey()`。默认**虚拟时钟**，`{ realTimers: true }` 走真时钟。 |
| **`tools/cdp.mjs`** | **headless 浏览器 + CDP 封装（共享）**：`findChrome()`（Windows 上兜底 Edge，找不到返回 null 让调用方跳过）、`launchChrome()`（spawn + 轮询 `/json/list` + WebSocket 配对）、`evaluate()`（取值并把页面异常变成可读失败）。`tools/shot.mjs` 与 `browser.mjs` 共用。仍只用 Node 内置能力，保持零依赖。 |
| `tools/audit_bank.mjs` | 题库体检报告：规模统计、拼音映射质量、韵母键覆盖率、词组/短文的字覆盖闭合性、拼音重复度。**改动题库后建议跑一次**，它会直接指出「哪些字只在词组里出现却练不到」这类不一致。 |
| `tools/dedupe_chars.mjs` | 单字表跨档去重。`--write` 才会写盘。 |
| `tools/gen_expand.mjs` | 题库扩充生成器：逐条校验候选内容（可拆分 / 无大写 / 字数对应 / 无重复 / 短文用字全覆盖），任何一条不过就整体失败。`--write` 才会写盘。 |
| `tools/shot.mjs` | headless Chrome + CDP 截图工具，用于视觉验证。用法：`node _test/tools/shot.mjs <url> <out.png> [width] [height] [script-file]`，可选 `script-file` 会在截图前注入执行（切视图 / 模拟按键）。注意两点：环境里有代理，必须带 `--no-proxy-server`；用 `--force-device-scale-factor=2` 才能看清细节。临时 profile 落在 `_test/.chrome-profile/`（已 gitignore）；Chrome 不在默认路径时可用 `CHROME_PATH` 环境变量指定。 |

## 运行

**推荐（一次装依赖，之后跑全部十套 + 基准）：**

```bash
cd _test
npm ci            # 按 package-lock.json 精确还原依赖（首次或换环境时执行）
npm test          # 依次跑 verify → clock → engine → storage → a11y → launcher → training → integration → browser → bench
```

也可以单独跑（每个套件都有对应的 `npm run test:xxx`）：

```bash
node _test/verify.mjs
node _test/clock.mjs
node _test/engine.mjs
node _test/storage.mjs
node _test/a11y.mjs
node _test/launcher.mjs
node _test/training.mjs
node _test/integration.mjs
node _test/browser.mjs   # 真浏览器冒烟：没有 Chrome/Edge 时自动跳过
node _test/bench.mjs     # 性能基准：每键 DOM 写入量
```

> Windows 下若 `node` 不在 PATH，可用 WorkBuddy 内置运行时：
> `"C:/Users/ASUS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" _test/verify.mjs`

### 依赖可复现性（为什么要用 `npm ci`）

`integration.mjs` 与 `bench.mjs` 需要 `linkedom` 来模拟 DOM，
`browser.mjs` 需要一个 Chromium 系浏览器（没有就跳过），其余七套**零依赖**。
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
各跑一遍全部测试（`fail-fast: false`，任一版本失败都能看到全部结果）：
`actions/checkout` → `setup-node` → `cd _test && npm ci` → `npm test`。
这样「检出目录没有 linkedom、集成测试跑不起来」的情况不会再出现 ——
依赖由锁文件保证，runner 每次都是干净且一致的。

> 这份工作流**本身**也被 `launcher.mjs` 的 I 组守着：文件存在、矩阵含三个
> 版本、用 `npm ci` 而非 `npm install`、在 `_test` 下执行、`actions/*` 用 v5。
> 之前 README 在描述一份并不存在的 CI —— 文档承诺的东西要么兑现，要么删掉。

### CI 第一次跑就抓到的真 bug（`type: module`）

工作流补上后第一次推送，Node 18/20 立刻挂，报：

```
SyntaxError: Named export 'ALL_CHARS' not found. The requested module
'../src/data/pinyin.js' is a CommonJS module, which may not support
all module.exports as named exports.
```

根因：`_test/package.json` 声明了 `"type": "module"`，但 `src/` 在它**外面**。
Node 从 `src/data/pinyin.js` 往上找最近的 `package.json`，一路到仓库根都没有，
于是按 CommonJS 处理这个 ES 模块。

本地开发完全看不出来 —— Node 24 有 **ESM 语法自动探测**，会把带 `import`/`export`
的 `.js` 重新判定为 ESM。只有真在 18/20 上跑才会暴露。

修法是根目录加一个 `package.json` 声明 `"type": "module"`（应用本体不读它，
浏览器靠 `<script type="module">`）。`launcher.mjs` 的 G 组现在会直接
`import()` 一次 `src/data/pinyin.js` 并检查导出，把这个症状钉在自检里。

> 教训：README 里「Node 18/20/22 各跑一遍」这句话，在工作流存在之前
> 是一句没人验证过的话。文档承诺的东西要么兑现，要么删掉 —— 两者都算改进，
> 放着不管不算。

### CI 第二次抓到的：定时断言在慢机上不可靠

修完上面那个，Node 18/22 绿了，Node 20 还红一项：
`✗ 暂停期间不计时（0.25 → 0.40）`。

同一个 `engine.mjs` 在本地 Node 24 连过很多次，只有慢的 runner 会红。这类
失败比语法错误更难查，因为它「本地是好的」。三处根因，都在测试里：

1. **固定 sleep 等定时器**。`await sleep(350)` 假定 250ms 的 tick 一定跑完，
   慢机上跑不完。改成按**引擎自己报的用时**轮询：
   `while (eng.activeSeconds() < 0.4) await sleep(50)`，并留兜底上限。
2. **基准取在 `pause()` 之前**。`pause()` 会调 `syncActiveTime()` 把上次 tick
   之后的零头并进 `elapsedSec`，而 `activeSeconds()` 早就算过这段零头 ——
   于是 pause 后的值天然会「跳」一下。拿 pause 前的值当基准，等于在断言
   「pause 补时」而不是「暂停期间不计时」。基准必须取在 `pause()` 之后。
3. **容差按本地机器的速度拍的**（0.15s）。慢机上零头接近 5s 上限，必然越界。
   改成 0.02s —— 暂停后引擎真的不再累加，差值应当接近 0。

修完在 18/20/22/24 上各连跑 4 轮，共 16 次全绿。
**教训：定时相关的断言要按被测对象的状态等，不要按墙钟猜。**

### 把「等毫秒」清掉之后（本轮）

上面那条教训只解决了 `engine.mjs` 的三处。清点下来，`integration.mjs` 里还有
**95 处** `await new Promise(r => setTimeout(r, N))`，累计 **4.3 秒**，
而且 **70% 紧跟在一次 `fire()` 之后** —— 典型形态是「点一下，然后赌 20ms 内
异步跑完了」。这既是可读性问题（看不出在等什么），也是 CI 偶发失败的来源。

本轮的做法：

1. **抽出共享基座**。`integration.mjs` / `bench.mjs` 原先各自抄了一份 ~140 行的
   linkedom 引导代码，两处会各自漂移。合并进 `tools/harness.mjs` 后，
   `integration.mjs` 从 2859 行降到 2635 行、`bench.mjs` 从 357 行降到 192 行，
   且两套从此共用同一份桩。
2. **能等状态的就等状态**。88 处「点完等接线」改成 `await settle()`；
   3 处「等防抖落盘」改成 `await waitFor(() => …)`（旧写法是盲等 400/500/480ms，
   快的时候白等、CI 忙的时候可能还没写下去）。
3. **该用虚拟时钟的用虚拟时钟**。提示/揭晓的时间线（`hintDelayMs=60` /
   `revealDelayMs=140`，检查间隔 80ms）改成 `advance(79/1/79/1)` 精确推进，
   断言从「等 320ms 然后看有没有」收紧成「79ms 不该有、80ms 该有；159ms 还没到
   检查点、160ms 才 reveal」。`engine.mjs` 的暂停计时、限时结束、速度统计同样改虚拟时钟。
4. **清理「靠真实等待凑用时」**。凡是以 `durationSec >= 1` 为前提的落库断言，
   改成直接给引擎记账（`elapsedSec = 2`），不再每键 sleep 30~40ms。
5. **顺带补上一条自检不变式**。`launcher.mjs` 新增【J】：`npm test` 链里引用的
   文件必须存在，且 `_test/` 下每个自检文件都必须挂进 `npm test`
   （历史上的 `training.mjs` 就是这样被漏掉的）。加完立刻抓出一个真实不一致
   —— `bench.mjs` 有 `bench` 却没有 `test:bench` 单项入口。
6. **补真浏览器冒烟**（下一节）。

结果：`integration.mjs` **17.6s → 6.0s**、`engine.mjs` **3.9s → 0.8s**，
全套九套 + 基准 **约 28s → 约 11s**，断言数不减反增
（集成 515 → 520；引擎 168 → 168）。新增的每条断言都做了**反向验证**：
去掉引擎的 `examMode` 硬闸门 → 「空闲 60 秒也不给提示」变红；去掉提示检查间隔的
80ms 下限 → 「79ms 不闪键位」变红；把按键防抖从 8ms 调到 8000ms →
「按键确实被受理」变红；从 `npm test` 里删掉 `clock.mjs` → 【J】变红。

> 唯一**保留真实等待**的两处，都在集成测试里且都写明了原因：
> `main.js:onKeyDown` 有一道 **8ms 按键防抖**（防输入法连发），两次按键间隔
> 小于 8ms 时第二下会被**直接丢掉** —— 不等，那一按根本没进引擎，
> 「题干未变」就成了假绿。

## `browser.mjs` 覆盖什么（真浏览器冒烟）

linkedom 集成测试再全，也有四类问题它**原理上就测不到**——都是「集成全绿、
真机一打开就是不对」的那类。本套件用 headless Chrome/Edge + CDP 各钉一条：

| 用例 | 为什么 linkedom 测不到 | 钉住的规则 |
|---|---|---|
| 【1】练习输入 | linkedom 没有**输入管线**，只能手动调 `pressKey()` | 用 CDP `Input.dispatchKeyEvent` 发**真实键盘事件**：物理键 → `keydown` → 引擎推进（keyIndex +1）；按错键不推进 |
| 【2】弹窗焦点 | linkedom 的 `focus()` 是空实现、没有 `document.activeElement`，焦点迁移**完全观测不到**（集成测试里的焦点断言靠的是测试桩自己造的焦点模型） | 真浏览器里：打开弹窗焦点自动落在弹窗内的 `[data-act]` 主按钮上；Tab 循环 6 次不逃出弹窗；Esc 关闭且焦点归还 |
| 【3】Canvas 统计 | linkedom 里 canvas 是**空桩**，`drawLine` 画没画根本不知道 | 真 canvas 上 `getImageData` 数**非透明像素**：三张统计图都必须真的画出了内容；且带 `role="img"` 与随数据更新的 `aria-label`（读屏替代） |
| 【4】窄屏布局 | linkedom 没有**布局**，`scrollWidth` 恒 0 | 390×844 下 `scrollWidth ≤ 390`（无横向滚动），导航与模式卡片仍渲染可用 |

环境策略：`tools/cdp.mjs` 的 `findChrome()` 找不到 Chromium 系浏览器（含 Edge 兜底）
时返回 null，本套件**跳过并 exit 0** —— CI 的 Linux runner 不保证有浏览器，
冒烟是「有真浏览器就加测」，不该让没有浏览器的环境红掉。
它会自己起一个临时本地服务（`serve.mjs` 子进程）并选空闲端口，跑完即关。

> 顺带修了一个真实缺陷（本套件的价值当场兑现）：三张统计 Canvas 之前
> **完全没有读屏替代** —— 没有 `role`、没有 `aria-label`，读屏软件只能念出
> 「图像」两个字，用户拿不到任何数据。现在 `index.html` 给了 `role="img"`
> 与静态兜底标签，`main.js` 在每次重绘时把**数据摘要**写进 `aria-label`
> （如「近 20 轮速度曲线，均值 43.2，最低 31，最高 58」），空态也如实说明。

**反向验证过**（每条新断言都确认会红，不是摆设）：

- 把 `main.js` 里三处动态 `aria-label` 注掉 → 三条「数据摘要」断言变红。
  这里还抓出**断言本身的一个坑**：只查「label 非空」时，`index.html` 的静态
  兜底（「练习成绩曲线」6 个字）就能蒙混过关 —— 断言曾全绿但形同虚设。
  改成对动态摘要的特征短语做匹配后才能红。
- 给 `historyChart` 的 `drawLine` 短路 → 「真的画出了像素（0 个）」变红。
- 给 `style.css` 加 `body { min-width: 700px }` 模拟布局回归 → 这里又抓出
  **一个断言坑**：拿 `scrollWidth` 跟 `window.innerWidth` 比是**无效的** ——
  内容放不下时 Chrome 会把布局视口一起撑大，两个数一起涨，比较恒成立。
  必须跟**我们模拟进去的**视口宽（390）比，那才是「手机屏幕有多宽」。

**为什么慢也值得**：这套件约 5 秒（要起真浏览器），是全套里最慢的一支。
它守的四个边界都不是理论风险 —— Canvas 读屏替代就是这次跑出来的真缺陷。

> `launcher.mjs` 在 Linux runner 上也能跑：它做的是**纯静态检查**（读字节、
> 匹配文本、校验接口约定），不依赖 Windows 运行时。真正的 `cmd.exe` 行为
> 只能在 Windows 上人眼确认 —— 这也是它被设计成静态检查的原因。

## 关于 `node_modules`

`_test/node_modules/` 里只装了 `linkedom`（含 19 个传递依赖）供 `integration.mjs`
与 `bench.mjs` 使用，**不进仓库**。其余七套零依赖，删掉整个目录也照样跑；
只有这两套需要它。

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
| G. 模块类型 | 根 `package.json` 声明 `"type": "module"`，`src/` 下没有覆盖它的子 `package.json`，并**真 `import()` 一次** `src/data/pinyin.js`（见下方 CI 事故记录） |
| I. CI 工作流 | 文件存在、矩阵含 Node 18/20/22、用 `npm ci` 而非 `npm install`、在 `_test` 下执行、`actions/*` 用 v5 |
| J. 覆盖完整性 | `npm test` 链里引用的每个文件都真实存在，且 `_test/` 下每个自检文件都挂进了 `npm test`、都有 `test:xxx` 单项入口（`serve.mjs` 白名单排除） |

> `serve.ps1` 除了静态检查，还支持 `-SelfTest` 参数：**真跑**一遍路径解析与
> 目录穿越防护的断言（含 `%2e%2e` / `..%2f` 等 URL 编码变体、相似前缀的兄弟目录），
> 但**不起监听、不占端口**。这样即使无法在沙箱里起服务，防护逻辑也是被真正执行验证过的。

## 测试环境的两处「降级垫片」（不是应用 bug）

`tools/harness.mjs` 会为 `linkedom` 补几个浏览器行为，避免把测试框架的缺陷误判成应用缺陷：

1. **`select.value` / `input.value` 可写** —— linkedom 把它们实现成了只读 getter。
2. **事件监听器捕获** —— linkedom 把监听器注册表存在模块私有的 WeakMap 中，
   外部读不到，测试无法触发 `addEventListener` 绑定的处理器；这里在元素层面
   额外记录一份到 `el.__handlers`，供测试派发事件。

还有几处是为了让应用里「能观测」的逻辑真的可观测：**焦点模型**（linkedom 的
`focus()` 是空实现、也没有 `document.activeElement`，于是「弹窗打开把焦点送进去 /
关闭后还回来」在测试里完全看不见）、**`offsetParent`**（`trapModalTab` 用它过滤
「可见」元素，linkedom 恒返回 `undefined`，会把候选全滤掉）、**canvas 2D 上下文桩**
（统计页画曲线用）。

## 时间相关的用例怎么写（重要）

早期这里踩过一串「本地绿、CI 红」的坑（见下方两节事故记录），根因都是
**用墙钟猜异步**。现在的规矩：

| 场景 | 写法 |
|---|---|
| 点一下之后等「接线落定」 | `await settle()` —— `fire()` 是同步的，绝大多数 `sleep(20)` 只是残留；`settle` 让出一轮事件循环，语义明确 |
| 等某个**状态**成立（如设置防抖落盘） | `await waitFor(() => …, { label })` —— 落盘就立刻返回，没落盘就等到超时 |
| **倒计时 / 提示到期 / 暂停计时** | 虚拟时钟：`createVirtualClock()` + `installVirtualWindow()`（裸引擎）或 `virtualizeWindowTimers()`（借出定时器），用 `advance(ms)` 精确推进，边界可断言到毫秒 |
| 确实依赖**真实时长**的少数几处 | 显式 `sleep` 并**写明原因**（目前只有按下文那两处：`main.js` 的 8ms 按键防抖、借虚拟时钟前的时序需要） |

两头都要防：

- **别赌**。`await sleep(20)` 是「赌 20ms 内异步跑完了」。快的时候白等，CI 忙的时候
  定时器被推迟就偶发红灯。
- **也别把断言等没了**。把等待改成 `settle()` 时要确认断言**不是靠「什么都没发生」
  成立的假绿。例子：集成测试里「音节内推进题干不变」若按键其实被 8ms 防抖丢掉了，
  题干当然「没变」—— 所以那里补了一条「按键确实被受理（pos 0 → 1）」。

关于「用时 ≥ 1 秒」这类前提：`persistRecord` 只在 `durationSec >= 1` 时落库，
所以易错表、成绩曲线、收尾音在**瞬时跑完**的练习里一件都不会发生。旧写法是每键
`sleep(30~40ms)` 去把 1 秒磨出来 —— 慢且不稳。现在直接给引擎记账
（`eng.elapsedSec = 2`）：用时是**被测代码要展示的数据**，靠真实等待去凑既费时
又不可靠。这类的「静默不发生」比直接报错更难查。

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

`browser.mjs` 已经在真浏览器里自动覆盖了一部分（输入、弹窗焦点、Canvas 出图、
窄屏不横向滚动）。剩下的视觉与手感仍需人眼确认：开始练习 → 故意按错 → 暂停/继续
→ 看统计曲线 → 错题复习。

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
