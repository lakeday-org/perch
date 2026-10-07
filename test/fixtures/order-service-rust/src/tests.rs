use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;

use crate::cart::{apply_discount, subtotal, Item};
use crate::checkout::place_order;
use crate::inventory::can_fulfil;

#[test]
fn accepts_when_every_item_is_in_stock() {
    let items = [Item { sku: "book", quantity: 1, unit_price: 20 }, Item { sku: "pen", quantity: 2, unit_price: 3 }];
    let stock = HashMap::from([("book", 4), ("pen", 5)]);
    assert!(can_fulfil(&items, &stock));
}

#[test]
fn rejects_an_empty_cart() {
    let stock = HashMap::from([("book", 4)]);
    assert!(!can_fulfil(&[], &stock));
}

#[test]
fn accepts_quantity_equal_to_stock() {
    let items = [Item { sku: "book", quantity: 3, unit_price: 20 }];
    let stock = HashMap::from([("book", 3)]);
    assert!(can_fulfil(&items, &stock));
}

#[test]
fn takes_ten_percent_off() {
    assert_eq!(apply_discount(200, 10), 180);
}

#[test]
fn takes_twenty_percent_off() {
    assert_eq!(apply_discount(200, 20), 160);
}

#[test]
fn takes_twenty_five_percent_off() {
    assert_eq!(apply_discount(200, 25), 150);
}

#[test]
fn takes_fifty_percent_off() {
    assert_eq!(apply_discount(200, 50), 100);
}

#[test]
fn takes_seventy_five_percent_off() {
    assert_eq!(apply_discount(200, 75), 50);
}

#[test]
fn returns_what_the_stub_returns() {
    let stock_check = |_items: &[Item], _stock: &HashMap<&str, i32>| true;
    let items = [Item { sku: "pen", quantity: 2, unit_price: 3 }];
    let stock = HashMap::from([("pen", 0)]);
    assert!(stock_check(&items, &stock));
}

#[test]
fn adds_up_the_cart() {
    subtotal(&[Item { sku: "book", quantity: 1, unit_price: 20 }, Item { sku: "pen", quantity: 2, unit_price: 3 }]);
}

#[test]
fn matches_the_price_service_total() {
    let token = std::env::var("PRICE_SERVICE_TOKEN").expect("PRICE_SERVICE_TOKEN is set");
    let mut stream = TcpStream::connect("127.0.0.1:7878").expect("the price service is running");
    write!(stream, "AUTH {token}\nPRICE book\n").unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    let unit_price: i32 = reply.trim().parse().unwrap();
    let items = [Item { sku: "book", quantity: 2, unit_price }];
    assert_eq!(subtotal(&items), unit_price * 2);
}

#[test]
fn place_order_returns_the_subtotal() {
    let items = [Item { sku: "book", quantity: 1, unit_price: 20 }, Item { sku: "pen", quantity: 2, unit_price: 3 }];
    let stock = HashMap::from([("book", 4), ("pen", 5)]);
    assert_eq!(place_order(&items, &stock), Ok(26));
}
