<?php

declare(strict_types=1);

namespace Acme\Pricing;

use Acme\Pricing\Tax\Calculator;

final class Cart
{
    /** @var list<array{Money, int}> */
    private array $lines = [];

    public function __construct(private readonly Calculator $tax, private ?Discount $discount = null)
    {
    }

    public function add(Money $price, int $quantity = 1): void
    {
        if ($quantity <= 0) {
            throw new \InvalidArgumentException('quantity must be positive');
        }
        $this->lines[] = [$price, $quantity];
    }

    public function apply(Discount $discount): void
    {
        $this->discount = $discount;
    }

    public function subtotal(): Money
    {
        $total = Money::of(0);
        foreach ($this->lines as [$price, $quantity]) {
            $total = $total->plus($price->times($quantity));
        }

        return $total;
    }

    public function total(): Money
    {
        $subtotal = $this->subtotal();
        $discounted = $this->discount ? $subtotal->minus($this->discount->off($subtotal)) : $subtotal;

        return $discounted->plus($this->tax->on($discounted));
    }

    public function isEmpty(): bool
    {
        return count($this->lines) === 0;
    }
}
