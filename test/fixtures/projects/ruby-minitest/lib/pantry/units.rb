module Pantry
  module Units
    GRAMS_PER = { "g" => 1, "kg" => 1000, "oz" => 28.35, "lb" => 453.6 }.freeze

    def self.to_grams(quantity, unit)
      factor = GRAMS_PER[unit]
      raise ArgumentError, "unknown unit #{unit}" unless factor
      quantity * factor
    end

    def self.convert(quantity, from, to)
      return quantity if from == to
      to_grams(quantity, from) / GRAMS_PER.fetch(to)
    end
  end
end
