<?php

declare(strict_types=1);

use Acme\Booking\Reservation;

it('counts the nights of a stay', function () {
    $stay = new Reservation(room(), 10, 13, 2);
    expect($stay->nights())->toBe(3);
});

it('rejects a stay that ends before it starts', function () {
    expect(fn () => new Reservation(room(), 13, 10, 1))->toThrow(InvalidArgumentException::class);
});

it('rejects more guests than the room sleeps', function () {
    expect(fn () => new Reservation(room(capacity: 2), 10, 12, 3))->toThrow(InvalidArgumentException::class);
});

describe('price', function () {
    it('charges the nightly rate per night', function () {
        expect((new Reservation(room(nightlyCents: 10000), 1, 4, 1))->priceCents())->toBe(30000);
    });

    it('takes ten percent off a week or longer', function () {
        expect((new Reservation(room(nightlyCents: 10000), 1, 8, 1))->priceCents())->toBe(63000);
    });
});

test('overlapping stays in the same room', function (int $checkIn, int $checkOut, bool $expected) {
    $first = new Reservation(room(), 10, 13, 1);
    $second = new Reservation(room(), $checkIn, $checkOut, 1);
    expect($first->overlaps($second))->toBe($expected);
})->with([[12, 15, true], [13, 16, false], [8, 10, false]]);
