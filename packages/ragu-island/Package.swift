// swift-tools-version: 6.0
import PackageDescription

// RaguIsland — a Dynamic-Island-style status indicator for the macOS notch that
// shows the live status of ragu sessions running on this machine.
//
// Unlike a hook-driven agent (where a compiled helper has to reconstruct liveness
// from one-way event files), ragu's own CLI process writes these state files
// directly (see packages/ragu/src/plugin/island/bridge.ts, which listens on
// ragu's live event bus) — so there is no hook-helper target here, just the
// shared schema (IslandCore) and the notch app itself.
//
// Pure SwiftPM, system frameworks only (AppKit/SwiftUI). No external dependencies.
let package = Package(
    name: "RaguIsland",
    platforms: [.macOS(.v14)],
    targets: [
        // Shared types + on-disk state schema, read by the app and (for reference/
        // tests) writable from Swift too, mirroring the TypeScript writer's contract.
        .target(
            name: "IslandCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The menu/notch app itself.
        .executableTarget(
            name: "RaguIsland",
            dependencies: ["IslandCore"],
            resources: [.copy("Resources/wordmark.png")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
