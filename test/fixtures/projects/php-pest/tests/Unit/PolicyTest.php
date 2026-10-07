<?php

declare(strict_types=1);

use Acme\Booking\Policy;
use Acme\Booking\Reservation;

describe('Policy', function () {
    beforeEach(function () {
        $this->policy = new Policy(minNights: 2, maxGuestsPerRoom: 3);
        $this->stay = new Reservation(room(capacity: 4), 20, 23, 2);
    });

    it('allows a stay within its limits', function () {
        expect($this->policy->allows($this->stay))->toBeTrue();
    });

    it('refuses too short a stay', function () {
        expect($this->policy->allows(new Reservation(room(), 20, 21, 1)))->toBeFalse();
    });

    it('refunds everything two weeks ahead', function () {
        expect($this->policy->refundPercent($this->stay, 1))->toBe(100);
    });

    test('refund percentages', function (int $cancelledOn, int $percent) {
        expect($this->policy->refundPercent($this->stay, $cancelledOn))->toBe($percent);
    })->with([[6, 100], [17, 50], [19, 0]]);
});
