//! Stock-keeping units: `TEA-0042`, a three-letter family, a dash and four digits.
const std = @import("std");

pub fn isValid(code: []const u8) bool {
    if (code.len != 8 or code[3] != '-') return false;
    for (code[0..3]) |c| {
        if (!std.ascii.isUpper(c)) return false;
    }
    for (code[4..]) |c| {
        if (!std.ascii.isDigit(c)) return false;
    }
    return true;
}

/// The family a valid code belongs to: `TEA` of `TEA-0042`.
pub fn family(code: []const u8) ?[]const u8 {
    if (!isValid(code)) return null;
    return code[0..3];
}

/// The number a valid code carries: 42 of `TEA-0042`.
pub fn number(code: []const u8) ?u16 {
    if (!isValid(code)) return null;
    return std.fmt.parseInt(u16, code[4..], 10) catch null;
}

test "isValid accepts three letters, a dash and four digits" {
    try std.testing.expect(isValid("TEA-0042"));
}

test "isValid rejects what a scanner mangles" {
    try std.testing.expect(!isValid("tea-0042"));
    try std.testing.expect(!isValid("TEA0042"));
    try std.testing.expect(!isValid("TEA-00042"));
}

test "family and number read a valid code" {
    try std.testing.expectEqualStrings("TEA", family("TEA-0042").?);
    try std.testing.expectEqual(@as(?u16, 42), number("TEA-0042"));
    try std.testing.expectEqual(@as(?u16, null), number("nope"));
}
