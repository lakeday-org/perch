<?php

declare(strict_types=1);

// Usage: php scripts/export.php "12.50 EUR"x2 "3.00 EUR"x1   Prints the taxed total of the lines given.
require __DIR__ . '/../vendor/autoload.php';

use Acme\Pricing\Cart;
use Acme\Pricing\Money;
use Acme\Pricing\Tax\Calculator;
use Acme\Pricing\Tax\Rate;

$tax = new Calculator();
$tax->register(new Rate('standard', 20.0));
$cart = new Cart($tax);
foreach (array_slice($argv, 1) as $line) {
    [$amount, $quantity] = explode('x', $line);
    $cart->add(Money::parse($amount), (int) $quantity);
}
fwrite(STDOUT, $cart->total()->format() . "\n");
