// Deliberately minimal: all business logic (API key auth, zip upload,
// AniList search, etc.) happens in the webview's own JS via fetch() against
// despair-world.com's /api/cache/uploader/* endpoints -- see src/main.js.
// This file is just the standard Tauri window shell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running despair uploader app");
}
