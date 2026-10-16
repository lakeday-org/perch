//! Prints a receipt for a dozen teas. Built as an executable by build.zig; no test runs it.
const std = @import("std");
const pantry = @import("pantry");

pub fn main() !void {
    var cart = pantry.Cart.init(std.heap.page_allocator);
    defer cart.deinit();
    try cart.add(.{ .code = "TEA-0042", .quantity = 12, .unit_cents = 350 });

    var buffer: [32]u8 = undefined;
    const stdout = std.io.getStdOut().writer();
    try stdout.print("subtotal {s}\n", .{try pantry.money.format(cart.subtotal(), &buffer)});
    try stdout.print("total    {s}\n", .{try pantry.money.format(try cart.total(775), &buffer)});
}
