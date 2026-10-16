<?php

declare(strict_types=1);

namespace Acme\Booking;

final class Room
{
    public function __construct(public readonly string $name, public readonly int $capacity, public readonly int $nightlyCents)
    {
        if ($capacity < 1) {
            throw new \InvalidArgumentException("$name must sleep at least one guest");
        }
    }

    public function fits(int $guests): bool
    {
        return $guests >= 1 && $guests <= $this->capacity;
    }
}
