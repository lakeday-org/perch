//! Flows across the package, run by `zig build test` as a second test root beside the unit tests in each file.
const std = @import("std");
const pantry = @import("root.zig");

test "a shopping trip: shelve, pick, and ring up" {
    var shelf = pantry.Shelf.init(std.testing.allocator);
    defer shelf.deinit();
    try shelf.receive("TEA-0042", 12);
    try shelf.pick("TEA-0042", 12);

    var cart = pantry.Cart.init(std.testing.allocator);
    defer cart.deinit();
    try cart.add(.{ .code = "TEA-0042", .quantity = 12, .unit_cents = 350 });
    try std.testing.expectEqual(@as(i64, 4200), cart.subtotal());
    try std.testing.expectEqual(@as(i64, 4073), try cart.total(775));
}

test "the best discount for a dozen teas is the bulk rate" {
    try std.testing.expectEqual(@as(u8, 10), pantry.rules.bestPercent(12, "TEA"));
    try std.testing.expectEqual(@as(i64, 3780), try pantry.money.applyPercent(4200, 10));
}
