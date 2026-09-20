use std::collections::HashMap;
use crate::cart::{Item, subtotal};
use crate::inventory::can_fulfil;

pub fn place_order(items: &[Item], stock: &HashMap<&str, i32>) -> Result<i32, &'static str> {
    if !can_fulfil(items, stock) {
        return Err("An item is out of stock");
    }
    Ok(subtotal(items))
}
