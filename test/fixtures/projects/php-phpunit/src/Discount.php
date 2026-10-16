<?php

declare(strict_types=1);

namespace Acme\Pricing;

final class Discount
{
    public function __construct(private readonly int $percent, private readonly int $minimumCents = 0)
    {
        if ($percent < 0 || $percent > 100) {
            throw new \InvalidArgumentException('a discount is between 0 and 100 percent');
        }
    }

    public static function none(): self
    {
        return new self(0);
    }

    public function appliesTo(Money $subtotal): bool
    {
        return $this->percent > 0 && $subtotal->cents >= $this->minimumCents;
    }

    public function off(Money $subtotal): Money
    {
        if (!$this->appliesTo($subtotal)) {
            return Money::of(0, $subtotal->currency);
        }

        return $subtotal->times($this->percent / 100);
    }
}
