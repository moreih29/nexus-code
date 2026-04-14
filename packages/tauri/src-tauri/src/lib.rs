use std::sync::{Arc, Mutex};
use std::net::TcpListener;
use tauri::{
    Manager, RunEvent, Runtime, State,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// 현재 spawn된 sidecar 프로세스 핸들 — 앱 종료 시 kill 보장
struct SidecarHandle(Arc<Mutex<Option<CommandChild>>>);

/// Sidecar가 바인딩한 포트 — `await_initialization` IPC로 webview에 전달
struct SidecarPort(Arc<Mutex<Option<u16>>>);

#[tauri::command]
async fn select_folder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
async fn await_initialization(
    port_state: State<'_, SidecarPort>,
) -> Result<u16, String> {
    let port = port_state.0.lock().map_err(|e| e.to_string())?;
    port.ok_or_else(|| "sidecar not initialized".to_string())
}

fn pick_free_port() -> Result<u16, std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_handle = Arc::new(Mutex::new(None::<CommandChild>));
    let sidecar_port = Arc::new(Mutex::new(None::<u16>));

    let sidecar_handle_for_run = sidecar_handle.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarHandle(sidecar_handle.clone()))
        .manage(SidecarPort(sidecar_port.clone()))
        .setup(move |app| {
            // 1) Free port 할당
            let port = pick_free_port().map_err(|e| format!("port bind failed: {}", e))?;
            *sidecar_port.lock().unwrap() = Some(port);

            // 2) sidecar spawn (binaries/nexus-sidecar-<triple>)
            let sidecar = app.shell()
                .sidecar("nexus-sidecar")
                .map_err(|e| format!("sidecar resolve failed: {}", e))?
                .env("PORT", port.to_string());

            let (_rx, child) = sidecar.spawn()
                .map_err(|e| format!("sidecar spawn failed: {}", e))?;
            *sidecar_handle.lock().unwrap() = Some(child);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![select_folder, await_initialization])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                // 앱 종료 시 sidecar 명시 kill (POC 부록 B #3 패턴)
                if let Ok(mut guard) = sidecar_handle_for_run.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
