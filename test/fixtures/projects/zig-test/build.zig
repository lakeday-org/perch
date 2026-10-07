const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const pantry = b.addModule("pantry", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const unit_tests = b.addTest(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const flow_tests = b.addTest(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
    });

    const test_step = b.step("test", "Run unit and flow tests");
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);
    test_step.dependOn(&b.addRunArtifact(flow_tests).step);

    const receipt = b.addExecutable(.{
        .name = "receipt",
        .root_source_file = b.path("examples/receipt.zig"),
        .target = target,
        .optimize = optimize,
    });
    receipt.root_module.addImport("pantry", pantry);
    b.installArtifact(receipt);
}
