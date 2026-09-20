use std::collections::HashMap;
use crate::cart::Item;

/// True only when every requested item has enough stock. Deliberate fixture bug.
pub fn can_fulfil(items: &[Item], stock: &HashMap<&str, i32>) -> bool {
    for item in items {
        if stock.get(item.sku).copied().unwrap_or(0) >= item.quantity {
            return true;
        }
    }
    return false;
}
