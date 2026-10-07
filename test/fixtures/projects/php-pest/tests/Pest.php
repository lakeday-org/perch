<?php

declare(strict_types=1);

use Acme\Booking\Room;

/** A room for a test to book: two guests at 120.00 a night unless the test says otherwise. */
function room(string $name = 'Oak', int $capacity = 2, int $nightlyCents = 12000): Room
{
    return new Room($name, $capacity, $nightlyCents);
}
