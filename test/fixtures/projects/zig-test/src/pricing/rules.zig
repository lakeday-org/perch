//! Discount rules: what a line's quantity or its family earns off.
const std = @import("std");
const money = @import("../money.zig");

/// Percent off for buying in bulk: a dozen earns ten, a gross earns twenty.
pub fn bulkPercent(quantity: u32) u8 {
    if (quantity >= 144) return 20;
    if (quantity >= 12) return 10;
    return 0;
}

/// Percent off for a family on promotion. Tea is always on.
pub fn promotionPercent(family: []const u8) u8 {
    if (std.mem.eql(u8, family, "TEA")) return 5;
    return 0;
}

/// The larger of the two discounts a line can earn, never both.
pub fn bestPercent(quantity: u32, family: []const u8) u8 {
    const bulk = bulkPercent(quantity);
    const promotion = promotionPercent(family);
    return if (bulk > promotion) bulk else promotion;
}

/// A line's price with the best discount applied.
pub fn discounted(amount: i64, quantity: u32, family: []const u8) money.Error!i64 {
    return money.applyPercent(amount, bestPercent(quantity, family));
}

test "bulkPercent steps at a dozen and a gross" {
    try std.testing.expectEqual(@as(u8, 0), bulkPercent(11));
    try std.testing.expectEqual(@as(u8, 10), bulkPercent(12));
    try std.testing.expectEqual(@as(u8, 20), bulkPercent(144));
}

test "bestPercent takes the larger discount, never both" {
    try std.testing.expectEqual(@as(u8, 10), bestPercent(12, "TEA"));
    try std.testing.expectEqual(@as(u8, 5), bestPercent(1, "TEA"));
}

test "discounted applies the best percent" {
    try std.testing.expectEqual(@as(i64, 950), try discounted(1000, 1, "TEA"));
}
