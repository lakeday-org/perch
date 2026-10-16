//! Amounts in cents, and the arithmetic a till does on them.
const std = @import("std");

pub const Error = error{ PercentOutOfRange, UnitNotPositive };

/// `amount` less `percent` of itself, rounded toward zero. 100 takes everything; more than that is an error.
pub fn applyPercent(amount: i64, percent: u8) Error!i64 {
    if (percent > 100) return Error.PercentOutOfRange;
    if (percent == 0) return amount;
    return amount - @divTrunc(amount * percent, 100);
}

/// `cents` rounded to the nearest multiple of `unit`, halves away from zero: Swiss rounding to five cents.
pub fn roundTo(cents: i64, unit: i64) Error!i64 {
    if (unit <= 0) return Error.UnitNotPositive;
    const remainder = @rem(cents, unit);
    const down = cents - remainder;
    if (remainder * 2 >= unit) return down + unit;
    if (remainder * 2 <= -unit) return down - unit;
    return down;
}

/// Tax on `amount` at `basis_points`, rounded to the nearest cent.
pub fn tax(amount: i64, basis_points: u16) i64 {
    const scaled = amount * basis_points;
    return @divTrunc(scaled + 5000, 10_000);
}

/// `cents` as "12.34", with a minus sign ahead of a negative amount.
pub fn format(cents: i64, buffer: []u8) ![]const u8 {
    const sign: []const u8 = if (cents < 0) "-" else "";
    const magnitude = @abs(cents);
    return std.fmt.bufPrint(buffer, "{s}{d}.{d:0>2}", .{ sign, magnitude / 100, magnitude % 100 });
}

test "applyPercent takes ten percent off" {
    try std.testing.expectEqual(@as(i64, 180), try applyPercent(200, 10));
}

test "applyPercent leaves a zero percent amount alone" {
    try std.testing.expectEqual(@as(i64, 250), try applyPercent(250, 0));
}

test "applyPercent refuses more than everything" {
    try std.testing.expectError(Error.PercentOutOfRange, applyPercent(200, 101));
}

test "roundTo rounds halves away from zero" {
    try std.testing.expectEqual(@as(i64, 125), try roundTo(123, 5));
    try std.testing.expectEqual(@as(i64, -125), try roundTo(-123, 5));
    try std.testing.expectError(Error.UnitNotPositive, roundTo(1, 0));
}

test "tax rounds to the nearest cent" {
    try std.testing.expectEqual(@as(i64, 8), tax(100, 775));
}

test format {
    var buffer: [32]u8 = undefined;
    try std.testing.expectEqualStrings("-12.05", try format(-1205, &buffer));
}
