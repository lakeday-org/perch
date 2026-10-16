<?php

declare(strict_types=1);

use Acme\Booking\Calendar;

beforeEach(function () {
    $this->calendar = new Calendar();
    $this->oak = room('Oak');
});

it('books a free room', function () {
    $stay = $this->calendar->book($this->oak, 10, 12, 2);
    expect($stay->nights())->toBe(2);
});

it('refuses a room already taken on those nights', function () {
    $this->calendar->book($this->oak, 10, 13);
    expect(fn () => $this->calendar->book($this->oak, 12, 14))->toThrow(DomainException::class);
});

it('tells whether a room is free', function () {
    $this->calendar->book($this->oak, 10, 13);
    expect($this->calendar->isFree($this->oak, 13, 15))->toBeTrue();
    expect($this->calendar->isFree(room('Elm'), 10, 13))->toBeTrue();
});

it('adds up the revenue of every stay', function () {
    $this->calendar->book($this->oak, 1, 3);
    $this->calendar->book(room('Elm', 4, 20000), 1, 2);
    expect($this->calendar->revenueCents())->toBe(44000);
});
