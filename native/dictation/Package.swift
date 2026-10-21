// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "T3SpeechWorker",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../phonon-coreml")],
    targets: [
        .executableTarget(name: "T3SpeechWorker", dependencies: [
            .product(name: "PhononCoreML", package: "phonon-coreml")
        ])
    ],
    swiftLanguageModes: [.v5]
)
