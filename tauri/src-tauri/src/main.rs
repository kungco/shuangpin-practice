// 桌面端入口。
//
// 只做一件事：调用库里的 run()。真正的逻辑写在 lib.rs ——
// Tauri 在移动端会把代码编成库、由平台框架加载，桌面端也走同一个入口，
// 这样两端只有一份启动逻辑。
//
// 这个文件按 Tauri 的约定**不需要修改**，要加东西请改 lib.rs。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shuangpin_practice_lib::run()
}
