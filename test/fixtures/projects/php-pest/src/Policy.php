<?php

declare(strict_types=1);

namespace Acme\Booking;

final class Policy
{
    public function __construct(private readonly int $minNights = 1, private readonly int $maxGuestsPerRoom = 4)
    {
    }

    public function allows(Reservation $reservation): bool
    {
        return $reservation->nights() >= $this->minNights && $reservation->guests <= $this->maxGuestsPerRoom;
    }

    public function refundPercent(Reservation $reservation, int $cancelledOn): int
    {
        $daysBefore = $reservation->checkIn - $cancelledOn;
        if ($daysBefore >= 14) {
            return 100;
        }
        if ($daysBefore >= 3) {
            return 50;
        }

        return 0;
    }
}
