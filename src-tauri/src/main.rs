// 桌面壳：静态资源由 Tauri asset 协议直接服务（app/ + vendor/），无本地服务器。
// 文件 I/O 走自定义命令（前端 app.js 里的 TAURI 分支），同步分块写入临时文件。
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

// 分块只改临时文件；最后一块写完再备份和替换，途中失败不动原文件。
#[tauri::command]
fn write_chunk(
    path: String, temporary_path: String, b64: String, append: bool, finish: bool,
) -> Result<(), String> {
    validate_temporary_path(&path, &temporary_path).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| {
            if append { let _ = std::fs::remove_file(&temporary_path); }
            e.to_string()
        })?;
    write_file_chunk(&path, &temporary_path, &data, append, finish).map_err(|e| e.to_string())
}

fn validate_temporary_path(path: &str, temporary_path: &str) -> std::io::Result<()> {
    // 同目录的独立临时名，由前端每次保存生成；禁止把原件或其他目录当临时文件。
    let prefix = format!("{path}.tmp-");
    let suffix = temporary_path.strip_prefix(&prefix).unwrap_or("");
    if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "临时文件路径无效"));
    }
    Ok(())
}

fn write_file_chunk(
    path: &str, temporary_path: &str, data: &[u8], append: bool, finish: bool,
) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true).append(append).create_new(!append)
        .open(temporary_path)?;
    let result = (|| {
        file.write_all(data)?;
        if !finish { return Ok(()); }
        file.sync_all()?;
        drop(file); // Windows 替换前必须关闭临时文件句柄。
        backup_original(path, temporary_path)?;
        // 同目录 rename 在 Windows 使用替换语义；无需先删除或截断原件。
        std::fs::rename(temporary_path, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary_path); }
    result
}

fn backup_original(path: &str, temporary_path: &str) -> std::io::Result<()> {
    let mut original = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let backup_path = format!("{path}.bak");
    let final_backup = std::path::Path::new(&backup_path);
    if final_backup.is_file() { return Ok(()); }
    if final_backup.try_exists()? {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "备份路径不是文件"));
    }
    // 备份也先写临时文件，意外退出时不会留下被下次保存误用的半份 .bak。
    let temporary_backup_path = format!("{temporary_path}.bak");
    let mut backup = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary_backup_path)?;
    let result = (|| {
        std::io::copy(&mut original, &mut backup)?;
        backup.sync_all()?;
        drop(backup);
        // 应用内保存已串行；提交前再查一次，保留期间出现的已有备份。
        if final_backup.try_exists()? {
            if !final_backup.is_file() {
                return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "备份路径不是文件"));
            }
            return std::fs::remove_file(&temporary_backup_path);
        }
        std::fs::rename(&temporary_backup_path, &backup_path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary_backup_path); }
    result
}

fn pdf_path_from_args(argv: &[String], cwd: &std::path::Path) -> Option<String> {
    let argument = argv.iter().skip(1).find(|argument| argument.to_lowercase().ends_with(".pdf"))?;
    let path = std::path::Path::new(argument);
    Some(if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) }.to_string_lossy().to_string())
}

// 前端等所有脚本和事件监听就绪后读取，避免冷启动事件早于监听而丢失。
#[tauri::command]
fn startup_pdf_path() -> Result<Option<String>, String> {
    let argv = std::env::args_os().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>();
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    Ok(pdf_path_from_args(&argv, &cwd))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 第二次启动（含双击 .pdf 文件关联）：把文件路径转给已运行实例
            if let Some(path) = pdf_path_from_args(&argv, std::path::Path::new(&cwd)) {
                let _ = app.emit("open-pdf-path", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![dialog_open_pdf, dialog_save_pdf, read_file, write_chunk, startup_pdf_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_only_complete_files_and_keeps_first_backup() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("pdfreader-save-{}-{unique}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("original.pdf").to_string_lossy().to_string();
        let temporary_path = format!("{path}.tmp-test");
        std::fs::write(&path, b"original").unwrap();
        write_file_chunk(&path, &temporary_path, b"first-", false, false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        write_file_chunk(&path, &temporary_path, b"second", true, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first-second");
        assert_eq!(std::fs::read(format!("{path}.bak")).unwrap(), b"original");
        write_file_chunk(&path, &temporary_path, b"new", false, true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read(format!("{path}.bak")).unwrap(), b"original");
        assert!(!std::path::Path::new(&temporary_path).exists());

        // 备份路径不可写（用同名目录模拟），不能继续替换原件。
        std::fs::remove_file(format!("{path}.bak")).unwrap();
        std::fs::create_dir(format!("{path}.bak")).unwrap();
        assert!(write_file_chunk(&path, &temporary_path, b"bad", false, true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!std::path::Path::new(&temporary_path).exists());

        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::remove_dir(format!("{path}.bak")).unwrap();
            std::fs::write(format!("{path}.bak"), b"original").unwrap();
            // 允许读原件但禁止删除/替换，实际验证 Windows rename 失败分支。
            let held_original = std::fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
            assert!(write_file_chunk(&path, &temporary_path, b"bad", false, true).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"new");
            assert_eq!(std::fs::read(format!("{path}.bak")).unwrap(), b"original");
            assert!(!std::path::Path::new(&temporary_path).exists());
            drop(held_original);
        }

        // 临时路径冲突不覆盖、也不删除既有文件；路径穿越被拒绝。
        std::fs::write(&temporary_path, b"unrelated").unwrap();
        assert!(write_file_chunk(&path, &temporary_path, b"bad", false, true).is_err());
        assert_eq!(std::fs::read(&temporary_path).unwrap(), b"unrelated");
        assert!(validate_temporary_path(&path, &format!("{path}.tmp-../other")).is_err());

        // 残留的备份临时文件不能被当成完成的备份，也不能在冲突时被覆盖。
        std::fs::remove_file(&temporary_path).unwrap();
        #[cfg(windows)]
        std::fs::remove_file(format!("{path}.bak")).unwrap();
        #[cfg(not(windows))]
        std::fs::remove_dir(format!("{path}.bak")).unwrap();
        let temporary_backup_path = format!("{temporary_path}.bak");
        std::fs::write(&temporary_backup_path, b"incomplete").unwrap();
        assert!(write_file_chunk(&path, &temporary_path, b"bad", false, true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read(&temporary_backup_path).unwrap(), b"incomplete");
        assert!(!std::path::Path::new(&format!("{path}.bak")).exists());
        assert!(!std::path::Path::new(&temporary_path).exists());
        write_file_chunk(&path, &format!("{path}.tmp-retry"), b"retried", false, true).unwrap();
        assert_eq!(std::fs::read(format!("{path}.bak")).unwrap(), b"new");
        assert_eq!(std::fs::read(&path).unwrap(), b"retried");

        let new_path = directory.join("new.pdf").to_string_lossy().to_string();
        write_file_chunk(&new_path, &format!("{new_path}.tmp-test"), b"created", false, true).unwrap();
        assert_eq!(std::fs::read(&new_path).unwrap(), b"created");
        assert!(!std::path::Path::new(&format!("{new_path}.bak")).exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_and_forwarded_arguments_use_the_launch_directory() {
        let cwd = std::env::temp_dir();
        let argv = vec!["pdfreader.exe".into(), "--flag".into(), "document.PDF".into()];
        assert_eq!(pdf_path_from_args(&argv, &cwd), Some(cwd.join("document.PDF").to_string_lossy().to_string()));
        let absolute = cwd.join("absolute.pdf").to_string_lossy().to_string();
        assert_eq!(pdf_path_from_args(&["pdfreader.exe".into(), absolute.clone()], &cwd), Some(absolute));
        assert!(pdf_path_from_args(&["pdfreader.exe".into()], &cwd).is_none());
    }
}
