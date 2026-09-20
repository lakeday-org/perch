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
