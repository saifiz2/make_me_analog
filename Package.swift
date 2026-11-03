// swift-tools-version:5.9
import PackageDescription

// BrickCore is plain Foundation and builds anywhere (its tests also run on Linux).
// The AnalogBrick app target needs AppKit/WebKit, so it is only added on macOS.

var products: [Product] = [
    .library(name: "BrickCore", targets: ["BrickCore"]),
]

var targets: [Target] = [
    .target(name: "BrickCore", path: "Sources/BrickCore"),
    .testTarget(name: "BrickCoreTests", dependencies: ["BrickCore"], path: "Tests/BrickCoreTests"),
]

#if os(macOS)
products.append(.executable(name: "AnalogBrick", targets: ["AnalogBrick"]))
targets.append(
    .executableTarget(
        name: "AnalogBrick",
        dependencies: ["BrickCore"],
        path: "Sources/AnalogBrick",
        linkerSettings: [
            .linkedFramework("AppKit"),
            .linkedFramework("WebKit"),
            .linkedFramework("ScreenCaptureKit"),
            .linkedFramework("IOKit"),
            .linkedFramework("ServiceManagement"),
            .linkedFramework("CoreMedia"),
        ]
    )
)
#endif

let package = Package(
    name: "AnalogBrick",
    platforms: [.macOS(.v13)],
    products: products,
    targets: targets
)
