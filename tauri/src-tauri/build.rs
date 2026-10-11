// Tauri 的构建脚本。它会读取 tauri.conf.json、把图标嵌进 exe、
// 生成权限相关的代码。内容固定，不需要改。
fn main() {
    tauri_build::build()
}
