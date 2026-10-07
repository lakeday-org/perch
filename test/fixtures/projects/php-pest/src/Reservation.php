<?php

declare(strict_types=1);

namespace Acme\Booking;

final class Reservation
{
    public function __construct(
        public readonly Room $room,
        public readonly int $checkIn,
        public readonly int $checkOut,
        public readonly int $guests,
    ) {
        if ($checkOut <= $checkIn) {
            throw new \InvalidArgumentException('a stay ends after it starts');
        }
        if (!$room->fits($guests)) {
            throw new \InvalidArgumentException("{$room->name} does not fit $guests guests");
        }
    }

    public function nights(): int
    {
        return $this->checkOut - $this->checkIn;
    }

    public function overlaps(Reservation $other): bool
    {
        return $this->room->name === $other->room->name
            && $this->checkIn < $other->checkOut
            && $other->checkIn < $this->checkOut;
    }

    public function priceCents(): int
    {
        $nights = $this->nights();
        $discount = $nights >= 7 ? 0.9 : 1.0;

        return (int) round($this->room->nightlyCents * $nights * $discount);
    }
}
