mod cart;
mod inventory;
mod checkout;

use std::collections::HashMap;
use crate::cart::Item;
use crate::checkout::place_order;

fn main() {
    let items = [Item { sku: "book", quantity: 1, unit_price: 20 }, Item { sku: "pen", quantity: 2, unit_price: 3 }];
    let stock = HashMap::from([("book", 4), ("pen", 0)]);
    println!("Accepted order total: {}", place_order(&items, &stock).unwrap());
}
