<?php

declare(strict_types=1);

namespace Acme\Pricing\Tests;

use Acme\Pricing\Cart;
use Acme\Pricing\Discount;
use Acme\Pricing\Money;
use Acme\Pricing\Tax\Calculator;
use Acme\Pricing\Tax\Rate;
use PHPUnit\Framework\TestCase;

final class CartTest extends TestCase
{
    private Cart $cart;

    protected function setUp(): void
    {
        $tax = new Calculator();
        $tax->register(new Rate('standard', 20.0));
        $this->cart = new Cart($tax);
    }

    public function testSubtotalAddsEveryLine(): void
    {
        $this->cart->add(Money::of(1000), 2);
        $this->cart->add(Money::of(550));
        $this->assertSame(2550, $this->cart->subtotal()->cents);
    }

    public function testTotalAddsTaxAfterTheDiscount(): void
    {
        $this->cart->add(Money::of(10000));
        $this->cart->apply(new Discount(10));
        $this->assertSame('108.00 EUR', $this->cart->total()->format());
    }

    public function testRejectsAZeroQuantity(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->cart->add(Money::of(100), 0);
    }

    public function testTaxIsAskedForTheDiscountedAmount(): void
    {
        $tax = $this->createMock(Calculator::class);
        $tax->expects($this->once())->method('on')->with(Money::of(9000))->willReturn(Money::of(0));
        $cart = new Cart($tax);
        $cart->add(Money::of(10000));
        $cart->apply(new Discount(10));
        $this->assertSame(9000, $cart->total()->cents);
    }
}
