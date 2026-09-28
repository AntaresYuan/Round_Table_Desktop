// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "RoundTableMacOS",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(name: "RoundTableContracts", targets: ["RoundTableContracts"]),
        .library(name: "RoundTableHostRuntimeCore", targets: ["RoundTableHostRuntimeCore"]),
        .library(name: "RoundTableScene", targets: ["RoundTableScene"]),
        .executable(name: "RoundTableAppBootstrap", targets: ["RoundTableAppBootstrap"]),
    ],
    targets: [
        .target(
            name: "RoundTableContracts",
            path: "Sources/RoundTableContracts"
        ),
        .target(
            name: "RoundTableHostRuntimeCore",
            dependencies: ["RoundTableContracts"],
            path: "Sources/RoundTableHostRuntimeCore"
        ),
        .executableTarget(
            name: "RoundTableAppBootstrap",
            dependencies: ["RoundTableContracts", "RoundTableScene"],
            path: "Sources",
            exclude: [
                "RoundTableContracts",
                "RoundTableHostRuntimeBootstrap",
                "RoundTableHostRuntimeCore",
                "RoundTableScene",
            ],
            sources: ["RoundTableAppBootstrap", "RoundTableBootstrapXPC"]
        ),
        .target(
            name: "RoundTableScene",
            path: "Sources/RoundTableScene"
        ),
        .testTarget(
            name: "RoundTableContractsTests",
            dependencies: ["RoundTableContracts"],
            path: "Tests/RoundTableContractsTests"
        ),
        .testTarget(
            name: "RoundTableHostRuntimeCoreTests",
            dependencies: ["RoundTableHostRuntimeCore"],
            path: "Tests/RoundTableHostRuntimeCoreTests"
        ),
        .testTarget(
            name: "RoundTableSceneTests",
            dependencies: ["RoundTableScene"],
            path: "Tests/RoundTableSceneTests"
        ),
    ]
)
