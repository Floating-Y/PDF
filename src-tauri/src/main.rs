// 桌面壳：静态资源由 Tauri asset 协议直接服务（app/ + vendor/），无本地服务器。
// 文件 I/O 走自定义命令（前端 app.js 里的 TAURI 分支），全部同步、无状态。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use tauri::{Emitter, Manager};

// 对话框命令用 async（跑在线程池）：同步命令在主线程开模态对话框有死锁风险。
// 路径用 to_string_lossy：非 UTF-8 路径（罕见）会得到错误路径 → 读文件时可见报错，
// 而不是 into_string().ok() 的静默无反应
#[tauri::command]
async fn dialog_open_pdf() -> Option<String> {
    rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn dialog_save_pdf(default_name: String) -> Option<String> {
    rfd::FileDialog::new()
        .set_file_name(default_name)
        .add_filter("PDF", &["pdf"])
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

// 读整个文件返回 base64（JSON 传大数组太慢；base64 单字符串两端都快）
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// 分块写：append=false 时先备份原文件为 .bak 再覆盖（写回原文件的数据丢失保险）
#[tauri::command]
fn write_chunk(path: String, b64: String, append: bool) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| e.to_string())?;
    if !append && std::path::Path::new(&path).exists() {
        let _ = std::fs::copy(&path, format!("{path}.bak")); // 备份失败也继续：覆盖保存不该被旧备份挡住
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!append)
        .append(append)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二次启动（含双击 .pdf 文件关联）：把文件路径转给已运行实例
            if let Some(p) = argv.iter().skip(1).find(|a| a.to_lowercase().ends_with(".pdf")) {
                let _ = app.emit("open-pdf-path", p.clone());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![dialog_open_pdf, dialog_save_pdf, read_file, write_chunk])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
