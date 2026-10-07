<?php

declare(strict_types=1);

namespace Acme\Pricing;

final class Money
{
    private function __construct(public readonly int $cents, public readonly string $currency)
    {
    }

    public static function of(int $cents, string $currency = 'EUR'): self
    {
        if ($cents < 0) {
            throw new \InvalidArgumentException('an amount cannot be negative');
        }

        return new self($cents, $currency);
    }

    public static function parse(string $text): self
    {
        if (!preg_match('/^(\d+)\.(\d{2}) ([A-Z]{3})$/', $text, $parts)) {
            throw new \InvalidArgumentException("not an amount: $text");
        }

        return self::of((int) $parts[1] * 100 + (int) $parts[2], $parts[3]);
    }

    public function plus(Money $other): self
    {
        $this->sameCurrency($other);

        return new self($this->cents + $other->cents, $this->currency);
    }

    public function minus(Money $other): self
    {
        $this->sameCurrency($other);

        return self::of($this->cents - $other->cents, $this->currency);
    }

    public function times(float $factor): self
    {
        return new self((int) round($this->cents * $factor), $this->currency);
    }

    public function isZero(): bool
    {
        return $this->cents === 0;
    }

    public function format(): string
    {
        return sprintf('%d.%02d %s', intdiv($this->cents, 100), $this->cents % 100, $this->currency);
    }

    private function sameCurrency(Money $other): void
    {
        if ($other->currency !== $this->currency) {
            throw new \InvalidArgumentException("cannot mix {$this->currency} and {$other->currency}");
        }
    }
}
