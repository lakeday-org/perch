<?php

declare(strict_types=1);

// A weekend in two rooms, with what it brings in.
require __DIR__ . '/../vendor/autoload.php';

use Acme\Booking\Calendar;
use Acme\Booking\Room;

$calendar = new Calendar();
$oak = new Room('Oak', 2, 12000);
$elm = new Room('Elm', 4, 20000);

$calendar->book($oak, 5, 7, 2);
$calendar->book($elm, 5, 6, 3);

printf("Revenue: %.2f\n", $calendar->revenueCents() / 100);
