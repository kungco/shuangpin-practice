# 自检脚本

三个互相独立的测试套件，**只用于开发期自检，不影响应用运行**。
（应用本身零依赖，但**不能直接双击 `index.html`** —— 浏览器禁止在 `file://`
协议下加载 ES 模块，必须经由本地 HTTP 服务打开。见文末说明。）

| 脚本 | 覆盖范围 | 依赖 |
|---|---|---|
| `verify.mjs` | 双拼方案正确性、题库可拆分性、键位表完整性、边界输入 | 无 |
| `engine.mjs` | 练习引擎逻辑：逐键校验、推进、统计、暂停、限时、异常输入 | 无 |
| `integration.mjs` | 在模拟 DOM 中加载整个应用，驱动完整交互流程 | `linkedom` |

另外有一个开发辅助脚本（**不属于测试**）：

- `make_lnk.py` —— 手写 Shell Link（MS-SHLLINK）二进制格式生成 Windows 快捷方式。
  之所以不用 `WScript.Shell.CreateShortcut()`，是因为当前环境的安全策略禁止 COM 实例化。
  用法：

  ```bash
  python _test/make_lnk.py <目标.lnk> <目标程序> [参数] [工作目录] [描述] [图标]
  ```

## 运行

```bash
node _test/verify.mjs
node _test/engine.mjs
node _test/integration.mjs
```

> Windows 下若 `node` 不在 PATH，可用 WorkBuddy 内置运行时：
> `"C:/Users/ASUS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" _test/verify.mjs`

## 关于 `node_modules`

`_test/node_modules/` 里只装了 `linkedom`（含其依赖）供 `integration.mjs` 使用。
如果不想保留这 5.4 MB，可以直接删掉整个目录 —— 前两个套件仍然可以运行，
`integration.mjs` 则会因缺少 `linkedom` 而无法启动。

重建方式：

```bash
cd _test && npm i linkedom --no-save
```

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

1. **双击桌面上的「双拼练习」快捷方式** —— 它会自动起本地服务并打开浏览器
   （`启动双拼练习.bat`，会自动挑一个空闲端口）。用完关掉那个最小化的服务窗口即可。
2. 手动起服务：在本目录执行 `python -m http.server 8781`，然后访问
   `http://127.0.0.1:8781/`。
3. 用 VS Code 的 Live Server 插件打开 `index.html`。

若不小心用 `file://` 打开了，页面会在 0.7 秒后弹出提示，告知上面这几种方式，
不会让你面对一片白屏。

## 本机额外验证

建议再用真实浏览器走一遍：开始练习 → 故意按错 → 暂停/继续
→ 看统计曲线 → 错题复习。集成测试只能覆盖到「接线」层面，视觉与交互手感需要人眼确认。
