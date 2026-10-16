require_relative "units"

module Pantry
  class Item
    attr_reader :name, :quantity, :unit

    def initialize(name, quantity, unit = "g")
      raise ArgumentError, "quantity must be positive" if quantity <= 0
      @name = name
      @quantity = quantity
      @unit = unit
    end

    def grams
      Units.to_grams(quantity, unit)
    end

    def low?(threshold_grams = 100)
      grams < threshold_grams
    end

    def merge(other)
      raise ArgumentError, "cannot merge #{other.name} into #{name}" unless other.name == name
      Item.new(name, grams + other.grams, "g")
    end
  end
end
