fn main() {
    // set_fullscreen is the one call the page may make into the shell (capabilities/remote.json allows it for
    // https://hearthcade.com only)
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_fullscreen"])),
    )
    .expect("tauri build script");
}
