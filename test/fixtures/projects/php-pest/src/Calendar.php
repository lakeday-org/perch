<?php

declare(strict_types=1);

namespace Acme\Booking;

final class Calendar
{
    /** @var list<Reservation> */
    private array $reservations = [];

    public function book(Room $room, int $checkIn, int $checkOut, int $guests = 1): Reservation
    {
        $reservation = new Reservation($room, $checkIn, $checkOut, $guests);
        if (!$this->isFree($room, $checkIn, $checkOut)) {
            throw new \DomainException("{$room->name} is taken on those nights");
        }
        $this->reservations[] = $reservation;

        return $reservation;
    }

    public function isFree(Room $room, int $checkIn, int $checkOut): bool
    {
        $wanted = new Reservation($room, $checkIn, $checkOut, 1);
        $clashes = array_filter($this->reservations, fn (Reservation $existing) => $existing->overlaps($wanted));

        return count($clashes) === 0;
    }

    public function revenueCents(): int
    {
        return array_sum(array_map(fn (Reservation $stay) => $stay->priceCents(), $this->reservations));
    }
}
