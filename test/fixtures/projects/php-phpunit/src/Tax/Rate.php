<?php

declare(strict_types=1);

namespace Acme\Pricing\Tax;

final class Rate
{
    public function __construct(public readonly string $code, public readonly float $percent)
    {
        if ($percent < 0.0 || $percent > 100.0) {
            throw new \InvalidArgumentException("$code: a rate is between 0 and 100 percent");
        }
    }

    public function isExempt(): bool
    {
        return $this->percent === 0.0;
    }
}
