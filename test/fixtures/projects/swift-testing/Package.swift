// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Parcel",
    products: [
        .library(name: "Parcel", targets: ["Parcel"]),
        .executable(name: "quote", targets: ["quote"]),
    ],
    targets: [
        .target(name: "Parcel"),
        .executableTarget(name: "quote", dependencies: ["Parcel"], path: "Examples/quote"),
        .testTarget(name: "ParcelTests", dependencies: ["Parcel"]),
    ]
)
