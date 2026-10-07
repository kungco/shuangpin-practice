# 自检脚本

四个互相独立的测试套件，**只用于开发期自检，不影响应用运行**。
（应用本身零依赖，但**不能直接双击 `index.html`** —— 浏览器禁止在 `file://`
协议下加载 ES 模块，必须经由本地 HTTP 服务打开。见文末说明。）

| 脚本 | 覆盖范围 | 依赖 |
|---|---|---|
| `verify.mjs` | 双拼方案正确性、题库可拆分性、键位表完整性、边界输入、**测验出题配比**、**评分算法** | 无 |
| `engine.mjs` | 练习引擎逻辑：逐键校验、推进、统计、暂停、限时、异常输入、**考试模式无提示硬约束** | 无 |
| `storage.mjs` | **存储降级**（配额满 → 内存 → 恢复落盘）、**导入合并**、**日报与历史一致性** | 无 |
| `integration.mjs` | 在模拟 DOM 中加载整个应用，驱动完整交互流程（含**能力测验端到端**） | `linkedom` |

> `storage.mjs` 是唯一「零依赖 + 毫秒级」的套件，且不引入 linkedom ——
> 因为 `storage.js` 本身不碰 DOM。适合改存储相关代码时高频单跑。

另有三个**开发辅助**脚本（属于工具，非测试）：

- `serve.mjs` —— 零依赖静态服务器，给 headless Chrome / 人工预览用。**别用
  `python -m http.server` 后台跑** —— 那个进程会随父 shell 一起被回收，
  截图时可能已经死掉（表现为 `ERR_CONNECTION_REFUSED`）。
  用法：`node _test/serve.mjs [port]`（默认 8791）。
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

**推荐（一次装依赖，之后跑全部四套）：**

```bash
cd _test
npm ci            # 按 package-lock.json 精确还原依赖（首次或换环境时执行）
npm test          # 依次跑 verify → engine → storage → integration
```

也可以单独跑：

```bash
node _test/verify.mjs
node _test/engine.mjs
node _test/storage.mjs
node _test/integration.mjs
```

> Windows 下若 `node` 不在 PATH，可用 WorkBuddy 内置运行时：
> `"C:/Users/ASUS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" _test/verify.mjs`

### 依赖可复现性（为什么要用 `npm ci`）

`integration.mjs` 需要 `linkedom` 来模拟 DOM，其余三套（`verify` / `engine` / `storage`）**零依赖**。
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
各跑一遍四套测试：
`actions/checkout` → `setup-node` → `cd _test && npm ci` → 依次执行四个脚本。
这样「检出目录没有 linkedom、集成测试跑不起来」的情况不会再出现 ——
依赖由锁文件保证，runner 每次都是干净且一致的。

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

测试用一个「按字节数判断」的 localStorage 桩模拟配额 —— 真实配额满不是
「setItem 永远抛」，而是取决于**这一条**的大小，所以桩里可以精确地
只打掉某一条写入，从而测出「清理老记录后重试成功」这条路径。

> 8 组用例都验证过「把旧实现注入回去会失败」：注入 bug 后【1】报 2 项、
> 【5】【6】共报 6 项未通过。

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
2. **手动起服务**：在仓库根目录执行 `python -m http.server 8781`，
   然后访问 `http://127.0.0.1:8781/`（macOS / Linux 用 `python3`）。
3. 用 VS Code 的 Live Server 插件打开 `index.html`。

> 桌面快捷方式不属于仓库内容 —— 本机那个 `.lnk` 是用 `make_lnk.py` 生成的，
> 别人 clone 下来没有。想在自己机器上也弄一个，跑一次该脚本即可（见上文说明）。

若不小心用 `file://` 打开了，页面会在 0.7 秒后弹出提示，告知上面这几种方式，
不会让你面对一片白屏。

## 本机额外验证

建议再用真实浏览器走一遍：开始练习 → 故意按错 → 暂停/继续
→ 看统计曲线 → 错题复习。集成测试只能覆盖到「接线」层面，视觉与交互手感需要人眼确认。
