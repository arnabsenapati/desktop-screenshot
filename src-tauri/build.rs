fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "start_capture",
                "close_overlay",
                "save_screenshot",
                "copy_screenshot",
                "search_image",
            ])),
    )
    .unwrap();
}
