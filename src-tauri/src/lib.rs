use tauri::{AppHandle, Manager, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use screenshots::Screen;
use mouse_position::mouse_position::Mouse;
use arboard::{Clipboard, ImageData};
use std::borrow::Cow;
use std::fs;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use std::io::Cursor;

// Custom Commands

#[tauri::command]
async fn start_capture(app: AppHandle) {
    if let Err(e) = capture_screen_and_open_overlay(app).await {
        eprintln!("Capture failed: {}", e);
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

async fn capture_screen_and_open_overlay(app: AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

        overlay_win.emit("screenshot-data", serde_json::json!({
            "dataUrl": data_url,
            "width": width,
            "height": height
        }))?;
    }

    Ok(())
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
                        if let Err(e) = capture_screen_and_open_overlay(app_handle).await {
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
            start_capture,
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
                    if let Err(e) = capture_screen_and_open_overlay(app_handle.clone()).await {
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
                        let widget_width = 85.0;
                        let x = screen_width - widget_width - 40.0;
                        let y = 60.0;
                        let _ = main_win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
                    }
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
