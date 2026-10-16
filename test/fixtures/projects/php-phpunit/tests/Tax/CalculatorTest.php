<?php

declare(strict_types=1);

namespace Acme\Pricing\Tests\Tax;

use Acme\Pricing\Money;
use Acme\Pricing\Tax\Calculator;
use Acme\Pricing\Tax\Rate;
use OutOfBoundsException;
use PHPUnit\Framework\TestCase;

final class CalculatorTest extends TestCase
{
    private Calculator $calculator;

    protected function setUp(): void
    {
        $this->calculator = new Calculator();
        $this->calculator->register(new Rate('standard', 20.0));
        $this->calculator->register(new Rate('books', 0.0));
    }

    public function testChargesTheRegisteredRate(): void
    {
        $this->assertSame(200, $this->calculator->on(Money::of(1000))->cents);
    }

    public function testChargesNothingOnAnExemptRate(): void
    {
        $this->assertTrue($this->calculator->on(Money::of(1000), 'books')->isZero());
    }

    /** @test */
    public function anUnknownCodeIsAnError(): void
    {
        $this->expectException(OutOfBoundsException::class);
        $this->calculator->rateFor('luxury');
    }

    public function testARateOutsideZeroToAHundredIsRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Rate('bad', 120.0);
    }
}
