<?php

declare(strict_types=1);

namespace Acme\Pricing\Tests;

use Acme\Pricing\Money;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class MoneyTest extends TestCase
{
    public function testParsesAnAmountWithItsCurrency(): void
    {
        $money = Money::parse('12.50 EUR');
        $this->assertSame(1250, $money->cents);
        $this->assertSame('EUR', $money->currency);
    }

    public function testRejectsANegativeAmount(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::of(-1);
    }

    #[Test]
    public function addsAmountsInTheSameCurrency(): void
    {
        $sum = Money::of(100)->plus(Money::of(250));
        $this->assertSame('3.50 EUR', $sum->format());
    }

    #[Test]
    public function refusesToAddAcrossCurrencies(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::of(100, 'EUR')->plus(Money::of(100, 'USD'));
    }

    #[DataProvider('factors')]
    public function testTimesRoundsToTheNearestCent(float $factor, int $expected): void
    {
        $this->assertSame($expected, Money::of(333)->times($factor)->cents);
    }

    public static function factors(): array
    {
        return [[1.0, 333], [0.5, 167], [0.1, 33]];
    }
}
