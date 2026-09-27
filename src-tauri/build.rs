fn main() {
    // Keep this list aligned with every frontend-invokable command.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "log_message",
            "quit_app",
            "start_capture",
            "start_marker",
            "start_burst_capture",
            "capture_region_frames",
            "set_widget_config_open",
            "set_widget_expanded",
            "move_widget",
            "move_widget_horizontal",
            "close_overlay",
            "save_screenshot",
            "copy_screenshot",
            "search_image",
            "switch_overlay_display",
        ]),
    ))
    .unwrap();
}
