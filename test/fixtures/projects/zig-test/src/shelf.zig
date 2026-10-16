//! What is on the shelf, by SKU.
const std = @import("std");
const sku = @import("sku.zig");

pub const Shelf = struct {
    const Self = @This();

    on_hand: std.StringHashMap(u32),

    pub fn init(allocator: std.mem.Allocator) Self {
        return .{ .on_hand = std.StringHashMap(u32).init(allocator) };
    }

    pub fn deinit(self: *Self) void {
        self.on_hand.deinit();
    }

    /// Puts `quantity` of a SKU on the shelf.
    pub fn receive(self: *Self, code: []const u8, quantity: u32) !void {
        if (!sku.isValid(code)) return error.InvalidSku;
        if (quantity == 0) return error.NothingReceived;
        const entry = try self.on_hand.getOrPutValue(code, 0);
        entry.value_ptr.* += quantity;
    }

    /// Takes `quantity` of a SKU off the shelf, or refuses when fewer are there.
    pub fn pick(self: *Self, code: []const u8, quantity: u32) !void {
        const held = self.onHand(code);
        if (quantity > held) return error.ShortStock;
        try self.on_hand.put(code, held - quantity);
    }

    pub fn onHand(self: *const Self, code: []const u8) u32 {
        return self.on_hand.get(code) orelse 0;
    }
};

test "receive adds to what is already on the shelf" {
    var shelf = Shelf.init(std.testing.allocator);
    defer shelf.deinit();
    try shelf.receive("TEA-0042", 3);
    try shelf.receive("TEA-0042", 2);
    try std.testing.expectEqual(@as(u32, 5), shelf.onHand("TEA-0042"));
}

test "pick refuses more than is on the shelf" {
    var shelf = Shelf.init(std.testing.allocator);
    defer shelf.deinit();
    try shelf.receive("TEA-0042", 1);
    try std.testing.expectError(error.ShortStock, shelf.pick("TEA-0042", 2));
}
