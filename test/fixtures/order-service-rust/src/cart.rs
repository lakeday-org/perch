pub struct Item {
    pub sku: &'static str,
    pub quantity: i32,
    pub unit_price: i32,
}

pub fn subtotal(items: &[Item]) -> i32 {
    let mut total = 0;
    for item in items {
        total += item.unit_price * item.quantity;
    }
    total
}

/// Take a percentage off a total. A discount of 100 percent or more makes the order free.
pub fn apply_discount(total: i32, percent: i32) -> i32 {
    if percent >= 100 {
        return 0;
    }
    total - total * percent / 100
}
