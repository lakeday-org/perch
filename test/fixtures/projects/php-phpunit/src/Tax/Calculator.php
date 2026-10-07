<?php

declare(strict_types=1);

namespace Acme\Pricing\Tax;

use Acme\Pricing\Money;

class Calculator
{
    /** @var array<string, Rate> */
    private array $rates = [];

    public function register(Rate $rate): void
    {
        $this->rates[$rate->code] = $rate;
    }

    public function rateFor(string $code): Rate
    {
        if (!isset($this->rates[$code])) {
            throw new \OutOfBoundsException("no tax rate $code");
        }

        return $this->rates[$code];
    }

    public function on(Money $amount, string $code = 'standard'): Money
    {
        $rate = $this->rateFor($code);
        if ($rate->isExempt()) {
            return Money::of(0, $amount->currency);
        }

        return $amount->times($rate->percent / 100);
    }
}
