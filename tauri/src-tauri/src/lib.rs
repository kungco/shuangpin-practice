//! 双拼练习的 Tauri 外壳。
//!
//! 【这个壳有多薄】本应用是**零依赖的静态站点**：一个 index.html、
//! 一个 assets/、一个 src/，全部逻辑都在 WebView 里跑。壳只需要做一件事 ——
//! 把这些文件用一个**真实 origin** 提供出去，让 ES 模块能正常 import、
//! 让 localStorage 有稳定的归属。
//!
//! 对比 Electron 版（desktop/main.cjs，169 行）：那边要手工注册自定义协议
//! `app://`（因为 file:// 下 ES 模块会被 CORS 拦掉）、要处理路径穿越、
//! 要在沙箱起不来时降级重启。Tauri 把「提供静态文件」做成了内建能力：
//! `build.frontendDist` 指向的目录会被自动服务在 `tauri://localhost`，
//! 这本身就是一个安全来源，localStorage 照常工作。
//! 于是上面那些代码在这里全都不需要 —— 这个文件就是全部。
//!
//! 【注意】应用启动后 WebView 加载的是 tauri://localhost 而不是
//! app://local，所以 **Tauri 版与 Electron 版的 localStorage 不互通**
//! （origin 不同）。这与「桌面版和网页版记录互相独立」是同一回事，
//! 属于预期行为，不是 bug。

/// 启动应用。
///
/// `#[cfg_attr(mobile, ...)]` 是 Tauri 的移动端入口标记；
/// 桌面端编译时它会被整个丢掉，留在这里是为了将来能直接复用到移动端。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 没有 .invoke_handler(...)：本应用不向 Rust 侧发任何命令。
        // 所有功能（练习引擎、统计、导入导出）都在 WebView 的 JS 里。
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
