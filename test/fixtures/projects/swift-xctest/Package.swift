// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Tally",
    products: [
        .library(name: "Tally", targets: ["Tally"]),
    ],
    targets: [
        .target(name: "Tally"),
        .testTarget(name: "TallyTests", dependencies: ["Tally"]),
    ]
)
