//! A shopping cart: lines of a SKU at a quantity and a unit price, and what they come to.
const std = @import("std");
const money = @import("money.zig");
const rules = @import("pricing/rules.zig");
const sku = @import("sku.zig");

pub const Line = struct {
    code: []const u8,
    quantity: u32,
    unit_cents: i64,

    /// What the line costs before any discount.
    pub fn gross(self: Line) i64 {
        return @as(i64, self.quantity) * self.unit_cents;
    }

    /// What the line costs after the best discount its quantity or family earns.
    pub fn net(self: Line) !i64 {
        const family = sku.family(self.code) orelse return error.InvalidSku;
        return rules.discounted(self.gross(), self.quantity, family);
    }
};

pub const Cart = struct {
    const Self = @This();

    lines: std.ArrayList(Line),

    pub fn init(allocator: std.mem.Allocator) Self {
        return .{ .lines = std.ArrayList(Line).init(allocator) };
    }

    pub fn deinit(self: *Self) void {
        self.lines.deinit();
    }

    /// Adds a line, or raises an existing line's quantity when the SKU is already in the cart.
    pub fn add(self: *Self, line: Line) !void {
        if (!sku.isValid(line.code)) return error.InvalidSku;
        if (line.quantity == 0) return error.EmptyLine;
        for (self.lines.items) |*held| {
            if (std.mem.eql(u8, held.code, line.code)) {
                held.quantity += line.quantity;
                return;
            }
        }
        try self.lines.append(line);
    }

    pub fn count(self: *const Self) usize {
        return self.lines.items.len;
    }

    /// The sum of every line before discounts.
    pub fn subtotal(self: *const Self) i64 {
        var sum: i64 = 0;
        for (self.lines.items) |line| sum += line.gross();
        return sum;
    }

    /// The sum of every line after discounts, plus tax at `tax_basis_points`.
    pub fn total(self: *const Self, tax_basis_points: u16) !i64 {
        var sum: i64 = 0;
        for (self.lines.items) |line| sum += try line.net();
        return sum + money.tax(sum, tax_basis_points);
    }
};

test "add merges a repeated SKU into one line" {
    var cart = Cart.init(std.testing.allocator);
    defer cart.deinit();
    try cart.add(.{ .code = "TEA-0042", .quantity = 2, .unit_cents = 350 });
    try cart.add(.{ .code = "TEA-0042", .quantity = 1, .unit_cents = 350 });
    try std.testing.expectEqual(@as(usize, 1), cart.count());
    try std.testing.expectEqual(@as(i64, 1050), cart.subtotal());
}

test "add refuses an invalid SKU and an empty line" {
    var cart = Cart.init(std.testing.allocator);
    defer cart.deinit();
    try std.testing.expectError(error.InvalidSku, cart.add(.{ .code = "nope", .quantity = 1, .unit_cents = 1 }));
    try std.testing.expectError(error.EmptyLine, cart.add(.{ .code = "TEA-0042", .quantity = 0, .unit_cents = 1 }));
}

test "total discounts each line and adds tax" {
    var cart = Cart.init(std.testing.allocator);
    defer cart.deinit();
    try cart.add(.{ .code = "TEA-0042", .quantity = 1, .unit_cents = 1000 });
    try std.testing.expectEqual(@as(i64, 1024), try cart.total(775));
}

test "Line.net applies the family promotion" {
    const line = Line{ .code = "TEA-0042", .quantity = 1, .unit_cents = 1000 };
    try std.testing.expectEqual(@as(i64, 950), try line.net());
}
