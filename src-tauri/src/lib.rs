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

// Custom Commands

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
async fn start_capture(app: AppHandle) {
    log_file("start_capture called");
    if let Err(e) = capture_screen_and_open_overlay(app, None).await {
        log_file(&format!("Capture failed: {}", e));
    }
}

#[tauri::command]
async fn start_burst_capture(app: AppHandle, count: u32, interval_ms: u64) {
    let count = count.clamp(2, 60);
    let interval_ms = interval_ms.clamp(100, 5_000);
    log_file(&format!("start_burst_capture called: {} frames, {} ms interval", count, interval_ms));
    if let Err(error) = capture_screen_and_open_overlay(app, Some((count, interval_ms))).await {
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
        let height = if open { 220.0 } else { 44.0 };
        let _ = main_win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(260.0, height)));
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

            let clamped_x = if let Ok(Some(monitor)) = main_win.primary_monitor() {
                let screen_width = monitor.size().width as f64 / scale_factor;
                let widget_width = main_win.outer_size().map(|s| s.width as f64 / scale_factor).unwrap_or(260.0);
                new_x.max(0.0).min(screen_width - widget_width)
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
    frame_capture: Option<(u32, u64)>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(main_win) = app.get_webview_window("main") {
        main_win.hide()?;
    }

    // Short delay to let the OS hide the widget window
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let (cx, cy) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        _ => (0, 0)
    };

    let screen = Screen::from_point(cx, cy).unwrap_or_else(|_| {
        Screen::all().unwrap_or_default().into_iter().next().expect("No screens found")
    });

    let image = screen.capture()?;
    
    let mut png_bytes = Vec::new();
    screenshots::image::DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut png_bytes), screenshots::image::ImageOutputFormat::Png)?;

    let base64_image = BASE64.encode(&png_bytes);
    let data_url = format!("data:image/png;base64,{}", base64_image);

    if let Some(overlay_win) = app.get_webview_window("overlay") {
        let display_info = screen.display_info;
        let x = display_info.x as f64;
        let y = display_info.y as f64;
        let width = display_info.width as f64;
        let height = display_info.height as f64;

        let _ = overlay_win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        let _ = overlay_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));

        overlay_win.show()?;
        overlay_win.set_focus()?;

        // Give the webview window a brief moment to process state change
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let (mode, frame_count, frame_interval_ms) = match frame_capture {
            Some((count, interval_ms)) => ("frame-selection", Some(count), Some(interval_ms)),
            None => ("screenshot", None, None),
        };

        overlay_win.emit("screenshot-data", serde_json::json!({
            "dataUrl": data_url,
            "width": width,
            "height": height,
            "mode": mode,
            "frameCount": frame_count,
            "frameIntervalMs": frame_interval_ms
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
    let (cursor_x, cursor_y) = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        _ => (0, 0),
    };
    let screen = match Screen::from_point(cursor_x, cursor_y) {
        Ok(screen) => screen,
        Err(_) => Screen::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .next()
            .ok_or_else(|| "No display is available for frame capture.".to_string())?,
    };

    for frame_index in 0..count {
        log_file(&format!("Capturing and copying frame {} of {}", frame_index + 1, count));
        let image = screen.capture().map_err(|error| error.to_string())?;
        let scale_x = image.width() as f64 / screen.display_info.width as f64;
        let scale_y = image.height() as f64 / screen.display_info.height as f64;
        let crop_x = (x * scale_x).round() as u32;
        let crop_y = (y * scale_y).round() as u32;
        let crop_width = (width * scale_x).round() as u32;
        let crop_height = (height * scale_y).round() as u32;

        if crop_width == 0
            || crop_height == 0
            || crop_x.saturating_add(crop_width) > image.width()
            || crop_y.saturating_add(crop_height) > image.height()
        {
            return Err("The selected region is outside the captured display.".to_string());
        }

        let cropped = screenshots::image::imageops::crop_imm(
            &image,
            crop_x,
            crop_y,
            crop_width,
            crop_height,
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
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let trigger = if shortcut == &Shortcut::new(None, Code::PrintScreen) {
                    true
                } else if shortcut == &Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS) {
                    true
                } else {
                    false
                };

                if trigger {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = capture_screen_and_open_overlay(app_handle, None).await {
                            eprintln!("Shortcut capture failed: {}", e);
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
            log_message,
            quit_app,
            start_capture,
            start_burst_capture,
            capture_region_frames,
            set_widget_config_open,
            move_widget_horizontal,
            close_overlay,
            save_screenshot,
            copy_screenshot,
            search_image
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            let is_instant_mode = args.contains(&"--instant".to_string()) || args.contains(&"--capture".to_string());

            if is_instant_mode {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = capture_screen_and_open_overlay(app_handle.clone(), None).await {
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
                        let widget_width = 210.0;
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

                let _ = app.global_shortcut().register(shortcut_print);
                let _ = app.global_shortcut().register(shortcut_ctrl_shift_s);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
