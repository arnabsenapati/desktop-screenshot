use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use screenshots::Screen;
use mouse_position::mouse_position::Mouse;
use arboard::{Clipboard, ImageData};
use std::borrow::Cow;
use std::fs;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use std::io::Cursor;

use std::fs::OpenOptions;
use std::io::Write;

fn log_file(msg: &str) {
    if let Ok(temp_dir) = std::env::var("TEMP") {
        let log_path = format!("{}\\desktop_screenshot.log", temp_dir);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(file, "[RUST] {}", msg);
        }
    }
}

#[cfg(target_os = "windows")]
fn kill_existing_instances() {
    use std::ffi::c_void;

    type HANDLE = *mut c_void;
    type BOOL = i32;
    type DWORD = u32;

    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    const TH32CS_SNAPPROCESS: DWORD = 0x00000002;
    const PROCESS_TERMINATE: DWORD = 0x0001;
    const FALSE: BOOL = 0;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: DWORD,
        cnt_usage: DWORD,
        th32_process_id: DWORD,
        th32_default_heap_id: usize,
        th32_module_id: DWORD,
        cnt_threads: DWORD,
        th32_parent_process_id: DWORD,
        pc_pri_class_base: i32,
        dw_flags: DWORD,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: DWORD, th32_process_id: DWORD) -> HANDLE;
        fn Process32FirstW(h_snapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn Process32NextW(h_snapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn OpenProcess(dw_desired_access: DWORD, b_inherit_handle: BOOL, dw_process_id: DWORD) -> HANDLE;
        fn TerminateProcess(h_process: HANDLE, u_exit_code: u32) -> BOOL;
        fn CloseHandle(h_object: HANDLE) -> BOOL;
    }

    let current_pid = std::process::id();
    let current_exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));

    let target_names = [
        "screenutil.exe",
        "screenutil",
        "screen-util.exe",
        "screen-util",
        "desktop-screenshot.exe",
        "desktop-screenshot",
    ];
    let mut killed_any = false;

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;

            if Process32FirstW(snapshot, &mut entry) != FALSE {
                loop {
                    let pid = entry.th32_process_id;
                    if pid != current_pid && pid != 0 {
                        let len = entry
                            .sz_exe_file
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.sz_exe_file.len());
                        let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_lowercase();

                        let is_match = target_names.iter().any(|&target| exe_name == target)
                            || current_exe_name
                                .as_ref()
                                .map_or(false, |curr| &exe_name == curr);

                        if is_match {
                            let handle = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
                            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                                let res = TerminateProcess(handle, 1);
                                CloseHandle(handle);
                                if res != FALSE {
                                    log_file(&format!(
                                        "Terminated existing instance: {} (PID: {})",
                                        exe_name, pid
                                    ));
                                    killed_any = true;
                                }
                            }
                        }
                    }

                    if Process32NextW(snapshot, &mut entry) == FALSE {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
    }

    if killed_any {
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_existing_instances() {}

const COMPACT_WIDGET_WIDTH: f64 = 196.0;
const EXPANDED_WIDGET_WIDTH: f64 = 278.0;
const SETTINGS_WIDGET_WIDTH: f64 = 300.0;
const WIDGET_HEIGHT: f64 = 44.0;
const SETTINGS_WIDGET_HEIGHT: f64 = 220.0;

fn resize_widget(main_win: &tauri::WebviewWindow, width: f64, height: f64) {
    let scale_factor = main_win.scale_factor().unwrap_or(1.0);
    let old_width = main_win
        .outer_size()
        .map(|size| size.width as f64 / scale_factor)
        .unwrap_or(width);
    let current_x = main_win
        .outer_position()
        .map(|position| position.x as f64 / scale_factor)
        .unwrap_or(0.0);
    let centered_x = current_x + (old_width - width) / 2.0;

    let _ = main_win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
    let _ = main_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(centered_x, 0.0)));
}

// Custom Commands

#[tauri::command]
fn get_displays() -> Vec<serde_json::Value> {
    let screens = Screen::all().unwrap_or_default();
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    for s in &screens {
        min_x = min_x.min(s.display_info.x);
        min_y = min_y.min(s.display_info.y);
    }
    screens.iter().enumerate().map(|(idx, s)| {
        let info = &s.display_info;
        let name = if info.is_primary {
            format!("Display {} (Main: {}×{})", idx + 1, info.width, info.height)
        } else {
            format!("Display {} (Secondary: {}×{})", idx + 1, info.width, info.height)
        };
        serde_json::json!({
            "index": idx,
            "id": info.id,
            "name": name,
            "isPrimary": info.is_primary,
            "x": (info.x - min_x) as f64,
            "y": (info.y - min_y) as f64,
            "width": info.width as f64,
            "height": info.height as f64,
            "scaleFactor": info.scale_factor
        })
    }).collect()
}

#[tauri::command]
fn log_message(msg: String) {
    log_file(&format!("[JS] {}", msg));
}

#[tauri::command]
fn quit_app() {
    log_file("quit_app called -> terminating process");
    std::process::exit(0);
}

#[tauri::command]
async fn start_capture(app: AppHandle, target_display: Option<i32>) {
    log_file(&format!("start_capture called with target_display: {:?}", target_display));
    if let Err(e) = capture_screen_and_open_overlay(app, "screenshot", None, target_display).await {
        log_file(&format!("Capture failed: {}", e));
    }
}

#[tauri::command]
async fn start_marker(app: AppHandle, target_display: Option<i32>) {
    log_file(&format!("start_marker called with target_display: {:?}", target_display));
    if let Err(e) = capture_screen_and_open_overlay(app, "marker", None, target_display).await {
        log_file(&format!("Marker failed: {}", e));
    }
}

#[tauri::command]
async fn switch_overlay_display(app: AppHandle, display_idx: i32, mode: Option<String>) {
    let mode_str = mode.unwrap_or_else(|| "screenshot".to_string());
    log_file(&format!("switch_overlay_display called with display_idx: {}", display_idx));
    if let Err(e) = capture_screen_and_open_overlay(app, &mode_str, None, Some(display_idx)).await {
        log_file(&format!("Switch overlay display failed: {}", e));
    }
}

#[tauri::command]
async fn start_burst_capture(app: AppHandle, count: u32, interval_ms: u64, target_display: Option<i32>) {
    let count = count.clamp(2, 60);
    let interval_ms = interval_ms.clamp(100, 5_000);
    log_file(&format!("start_burst_capture called: {} frames, {} ms interval, target_display: {:?}", count, interval_ms, target_display));
    if let Err(error) = capture_screen_and_open_overlay(app, "frame-selection", Some((count, interval_ms)), target_display).await {
        log_file(&format!("Unable to open frame selection: {}", error));
    }
}

#[tauri::command]
async fn capture_region_frames(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    count: u32,
    interval_ms: u64,
) -> Result<(), String> {
    let count = count.clamp(2, 60);
    let interval_ms = interval_ms.clamp(100, 5_000);
    log_file(&format!(
        "capture_region_frames called: x={}, y={}, width={}, height={}, {} frames, {} ms interval",
        x, y, width, height, count, interval_ms
    ));

    if let Some(overlay_win) = app.get_webview_window("overlay") {
        overlay_win.hide().map_err(|error| error.to_string())?;
    }

    let result = capture_region_frames_to_clipboard(x, y, width, height, count, interval_ms).await;

    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }

    match &result {
        Ok(()) => {
            let message = format!(
                "Copied {} frames to the clipboard, {} ms apart.\n\nEach frame is a separate image for your clipboard manager.",
                count, interval_ms
            );
            log_file(&message);
            rfd::MessageDialog::new()
                .set_title("Frames copied to clipboard")
                .set_description(&message)
                .set_level(rfd::MessageLevel::Info)
                .show();
        }
        Err(error) => log_file(&format!("Frame capture failed: {}", error)),
    }

    result
}

#[tauri::command]
fn set_widget_config_open(app: AppHandle, open: bool) {
    if let Some(main_win) = app.get_webview_window("main") {
        let (width, height) = if open {
            (SETTINGS_WIDGET_WIDTH, SETTINGS_WIDGET_HEIGHT)
        } else {
            (EXPANDED_WIDGET_WIDTH, WIDGET_HEIGHT)
        };
        resize_widget(&main_win, width, height);
    }
}

#[tauri::command]
fn set_widget_expanded(app: AppHandle, expanded: bool) {
    if let Some(main_win) = app.get_webview_window("main") {
        let width = if expanded {
            EXPANDED_WIDGET_WIDTH
        } else {
            COMPACT_WIDGET_WIDTH
        };
        resize_widget(&main_win, width, WIDGET_HEIGHT);
    }
}

#[tauri::command]
fn move_widget_horizontal(app: AppHandle, dx: f64) {
    log_file(&format!("move_widget_horizontal called: dx={}", dx));
    if let Some(main_win) = app.get_webview_window("main") {
        if let Ok(pos) = main_win.outer_position() {
            let scale_factor = main_win.scale_factor().unwrap_or(1.0);
            let current_x = pos.x as f64 / scale_factor;
            let new_x = current_x + dx;

            let monitors = main_win.available_monitors().unwrap_or_default();
            let clamped_x = if !monitors.is_empty() {
                let mut min_logical_x = f64::MAX;
                let mut max_logical_x = f64::MIN;
                for m in &monitors {
                    let sf = m.scale_factor();
                    let m_pos = m.position();
                    let m_size = m.size();
                    let left = m_pos.x as f64 / sf;
                    let right = (m_pos.x + m_size.width as i32) as f64 / sf;
                    min_logical_x = min_logical_x.min(left);
                    max_logical_x = max_logical_x.max(right);
                }
                let widget_width = main_win.outer_size().map(|s| s.width as f64 / scale_factor).unwrap_or(260.0);
                new_x.max(min_logical_x).min(max_logical_x - widget_width)
            } else {
                new_x
            };

            let _ = main_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(clamped_x, 0.0)));
        }
    }
}

#[tauri::command]
fn close_overlay(app: AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let is_instant_mode = args.contains(&"--instant".to_string()) || args.contains(&"--capture".to_string());

    if is_instant_mode {
        app.exit(0);
    } else {
        if let Some(overlay_win) = app.get_webview_window("overlay") {
            let _ = overlay_win.hide();
        }
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.show();
            let _ = main_win.set_focus();
        }
    }
}

#[tauri::command]
fn save_screenshot(data_url: String) -> bool {
    let base64_str = match data_url.strip_prefix("data:image/png;base64,") {
        Some(s) => s,
        None => return false
    };

    let png_bytes = match BASE64.decode(base64_str) {
        Ok(b) => b,
        Err(_) => return false
    };

    let file_path = rfd::FileDialog::new()
        .add_filter("PNG Image", &["png"])
        .set_directory("/")
        .save_file();

    if let Some(path) = file_path {
        fs::write(path, png_bytes).is_ok()
    } else {
        false
    }
}

#[tauri::command]
fn copy_screenshot(data_url: String) -> bool {
    let base64_str = match data_url.strip_prefix("data:image/png;base64,") {
        Some(s) => s,
        None => return false
    };

    let png_bytes = match BASE64.decode(base64_str) {
        Ok(b) => b,
        Err(_) => return false
    };

    let img = match image::load_from_memory(&png_bytes) {
        Ok(i) => i,
        Err(_) => return false
    };

    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let raw_bytes = rgba.into_raw();

    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(_) => return false
    };

    let image_data = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(raw_bytes),
    };

    clipboard.set_image(image_data).is_ok()
}

#[tauri::command]
async fn search_image(data_url: String) -> bool {
    let base64_str = match data_url.strip_prefix("data:image/png;base64,") {
        Some(s) => s,
        None => return false
    };

    let png_bytes = match BASE64.decode(base64_str) {
        Ok(b) => b,
        Err(_) => return false
    };

    match search_image_google(png_bytes).await {
        Ok(url) => {
            let _ = open::that(url);
            true
        }
        Err(e) => {
            eprintln!("Google Image search failed: {}", e);
            false
        }
    }
}

async fn search_image_google(png_bytes: Vec<u8>) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let form = reqwest::multipart::Form::new()
        .part("encoded_image", reqwest::multipart::Part::bytes(png_bytes).file_name("screenshot.png").mime_str("image/png")?)
        .text("image_url", "")
        .text("sbisrc", "cr_1_9_0");

    let response = client.post("https://images.google.com/searchbyimage/upload")
        .multipart(form)
        .send()
        .await?;

    if response.status().is_redirection() {
        if let Some(location) = response.headers().get("location") {
            return Ok(location.to_str()?.to_string());
        }
    }
    Err("No redirect URL found".into())
}

// Capture helper

async fn capture_screen_and_open_overlay(
    app: AppHandle,
    mode: &str,
    frame_capture: Option<(u32, u64)>,
    target_display: Option<i32>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(main_win) = app.get_webview_window("main") {
        main_win.hide()?;
    }

    // Short delay to let the OS hide the widget window
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let screens = Screen::all().unwrap_or_default();
    if screens.is_empty() {
        return Err("No displays detected".into());
    }

    let (cx, cy) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        _ => (0, 0),
    };

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    for s in &screens {
        min_x = min_x.min(s.display_info.x);
        min_y = min_y.min(s.display_info.y);
    }

    let display_meta: Vec<serde_json::Value> = screens.iter().enumerate().map(|(idx, s)| {
        let info = &s.display_info;
        let display_name = if info.is_primary {
            format!("Display {} (Main: {}×{})", idx + 1, info.width, info.height)
        } else {
            format!("Display {} (Secondary: {}×{})", idx + 1, info.width, info.height)
        };
        serde_json::json!({
            "index": idx,
            "id": info.id,
            "name": display_name,
            "isPrimary": info.is_primary,
            "x": (info.x - min_x) as f64,
            "y": (info.y - min_y) as f64,
            "width": info.width as f64,
            "height": info.height as f64,
            "scaleFactor": info.scale_factor,
        })
    }).collect();

    // Determine target screen index
    // target_display:
    // Some(idx >= 0) => capture that specific screen
    // Some(-1) => capture all screens (stitched)
    // None or Some(-2) => auto-detect screen containing mouse cursor (or screen 0)
    let selected_idx = match target_display {
        Some(idx) if idx >= 0 && (idx as usize) < screens.len() => Some(idx as usize),
        Some(-1) => None, // None means capture all screens
        _ => {
            let cursor_idx = screens.iter().position(|s| {
                let info = &s.display_info;
                cx >= info.x
                    && cx < (info.x + info.width as i32)
                    && cy >= info.y
                    && cy < (info.y + info.height as i32)
            });
            cursor_idx.or(Some(0))
        }
    };

    let (captured_data_url, win_x, win_y, win_w, win_h, active_idx) = match selected_idx {
        Some(idx) => {
            // Capture the single targeted screen
            let screen = &screens[idx];
            let info = &screen.display_info;
            let img = screen.capture()?;

            let mut png_bytes = Vec::new();
            screenshots::image::DynamicImage::ImageRgba8(img)
                .write_to(&mut Cursor::new(&mut png_bytes), screenshots::image::ImageOutputFormat::Png)?;

            let base64_image = BASE64.encode(&png_bytes);
            let data_url = format!("data:image/png;base64,{}", base64_image);

            (data_url, info.x, info.y, info.width, info.height, idx)
        }
        None => {
            // Capture all screens stitched together
            let mut max_x = i32::MIN;
            let mut max_y = i32::MIN;
            for s in &screens {
                let info = &s.display_info;
                max_x = max_x.max(info.x + info.width as i32);
                max_y = max_y.max(info.y + info.height as i32);
            }
            let total_width = (max_x - min_x).max(1) as u32;
            let total_height = (max_y - min_y).max(1) as u32;

            let mut combined_image = screenshots::image::RgbaImage::new(total_width, total_height);
            for s in &screens {
                let info = &s.display_info;
                if let Ok(img) = s.capture() {
                    let offset_x = (info.x - min_x) as i64;
                    let offset_y = (info.y - min_y) as i64;
                    screenshots::image::imageops::overlay(&mut combined_image, &img, offset_x, offset_y);
                }
            }

            let mut png_bytes = Vec::new();
            screenshots::image::DynamicImage::ImageRgba8(combined_image)
                .write_to(&mut Cursor::new(&mut png_bytes), screenshots::image::ImageOutputFormat::Png)?;

            let base64_image = BASE64.encode(&png_bytes);
            let data_url = format!("data:image/png;base64,{}", base64_image);

            (data_url, min_x, min_y, total_width, total_height, 0)
        }
    };

    if let Some(overlay_win) = app.get_webview_window("overlay") {
        let _ = overlay_win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(win_x, win_y)));
        let _ = overlay_win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(win_w, win_h)));

        overlay_win.show()?;
        overlay_win.set_focus()?;

        // Give the webview window a brief moment to process state change
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (frame_count, frame_interval_ms) = match frame_capture {
            Some((count, interval_ms)) => (Some(count), Some(interval_ms)),
            None => (None, None),
        };

        overlay_win.emit("screenshot-data", serde_json::json!({
            "dataUrl": captured_data_url,
            "width": win_w as f64,
            "height": win_h as f64,
            "mode": mode,
            "frameCount": frame_count,
            "frameIntervalMs": frame_interval_ms,
            "displays": display_meta,
            "activeDisplayIndex": active_idx,
            "isAllDisplays": selected_idx.is_none()
        }))?;
    }

    Ok(())
}

async fn capture_region_frames_to_clipboard(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    count: u32,
    interval_ms: u64,
) -> Result<(), String> {
    if x < 0.0 || y < 0.0 || width < 1.0 || height < 1.0 {
        return Err("Select a non-empty screen region first.".to_string());
    }

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let screens = Screen::all().map_err(|error| error.to_string())?;
    if screens.is_empty() {
        return Err("No display is available for frame capture.".to_string());
    }

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for s in &screens {
        let info = &s.display_info;
        min_x = min_x.min(info.x);
        min_y = min_y.min(info.y);
        max_x = max_x.max(info.x + info.width as i32);
        max_y = max_y.max(info.y + info.height as i32);
    }

    let total_width = (max_x - min_x).max(1) as u32;
    let total_height = (max_y - min_y).max(1) as u32;

    let crop_x = x.round() as u32;
    let crop_y = y.round() as u32;
    let crop_w = width.round() as u32;
    let crop_h = height.round() as u32;

    if crop_w == 0
        || crop_h == 0
        || crop_x.saturating_add(crop_w) > total_width
        || crop_y.saturating_add(crop_h) > total_height
    {
        return Err("The selected region is outside the captured screen area.".to_string());
    }

    for frame_index in 0..count {
        log_file(&format!("Capturing and copying frame {} of {}", frame_index + 1, count));
        let mut combined = screenshots::image::RgbaImage::new(total_width, total_height);
        for s in &screens {
            if let Ok(img) = s.capture() {
                let off_x = (s.display_info.x - min_x) as i64;
                let off_y = (s.display_info.y - min_y) as i64;
                screenshots::image::imageops::overlay(&mut combined, &img, off_x, off_y);
            }
        }

        let cropped = screenshots::image::imageops::crop_imm(
            &combined,
            crop_x,
            crop_y,
            crop_w,
            crop_h,
        )
        .to_image();

        copy_frame_to_clipboard(cropped)?;

        if frame_index + 1 < count {
            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
        }
    }

    Ok(())
}

fn copy_frame_to_clipboard(image: screenshots::image::RgbaImage) -> Result<(), String> {
    let (width, height) = image.dimensions();
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(image.into_raw()),
        })
        .map_err(|error| error.to_string())
}

// App Entry Point

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    kill_existing_instances();

    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let is_screenshot_shortcut = shortcut == &Shortcut::new(None, Code::PrintScreen)
                    || shortcut == &Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS);
                let is_marker_shortcut = shortcut == &Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);

                if is_screenshot_shortcut {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = capture_screen_and_open_overlay(app_handle, "screenshot", None, None).await {
                            eprintln!("Shortcut capture failed: {}", e);
                        }
                    });
                } else if is_marker_shortcut {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = capture_screen_and_open_overlay(app_handle, "marker", None, None).await {
                            eprintln!("Shortcut marker failed: {}", e);
                        }
                    });
                }
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(shortcut_plugin)
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_displays,
            log_message,
            quit_app,
            start_capture,
            start_marker,
            start_burst_capture,
            capture_region_frames,
            set_widget_config_open,
            set_widget_expanded,
            move_widget_horizontal,
            close_overlay,
            save_screenshot,
            copy_screenshot,
            search_image,
            switch_overlay_display
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let is_instant_mode = args.contains(&"--instant".to_string()) || args.contains(&"--capture".to_string());

            if is_instant_mode {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = capture_screen_and_open_overlay(app_handle.clone(), "screenshot", None, None).await {
                        eprintln!("Instant capture failed: {}", e);
                        rfd::MessageDialog::new()
                            .set_title("Capture Error")
                            .set_description(&format!("Failed to capture screen: {}", e))
                            .set_level(rfd::MessageLevel::Error)
                            .show();
                        app_handle.exit(1);
                    }
                });
            } else {
                if let Some(main_win) = app.get_webview_window("main") {
                    if let Ok(Some(monitor)) = main_win.primary_monitor() {
                        let size = monitor.size();
                        let scale_factor = monitor.scale_factor();
                        let screen_width = size.width as f64 / scale_factor;
                        let widget_width = COMPACT_WIDGET_WIDTH;
                        let x = (screen_width - widget_width) / 2.0; // Center top
                        let y = 0.0; // Pinned flush to top edge
                        let _ = main_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                    }

                    // Snap y to 0 whenever window is moved natively
                    let main_clone = main_win.clone();
                    main_win.on_window_event(move |event| {
                        if let tauri::WindowEvent::Moved(pos) = event {
                            let scale_factor = main_clone.scale_factor().unwrap_or(1.0);
                            let y_logical = pos.y as f64 / scale_factor;
                            if y_logical.abs() > 0.5 {
                                let x_logical = pos.x as f64 / scale_factor;
                                let _ = main_clone.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x_logical, 0.0)));
                            }
                        }
                    });

                    let _ = main_win.show();
                }

                let shortcut_print = Shortcut::new(None, Code::PrintScreen);
                let shortcut_ctrl_shift_s = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS);
                let shortcut_ctrl_shift_d = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);

                let _ = app.global_shortcut().register(shortcut_print);
                let _ = app.global_shortcut().register(shortcut_ctrl_shift_s);
                let _ = app.global_shortcut().register(shortcut_ctrl_shift_d);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
