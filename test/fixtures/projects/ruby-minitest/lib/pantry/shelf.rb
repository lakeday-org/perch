require_relative "item"

module Pantry
  class Shelf
    def initialize
      @items = {}
    end

    def add(item)
      existing = @items[item.name]
      @items[item.name] = existing ? existing.merge(item) : item
      self
    end

    def find(name)
      @items.fetch(name) { raise KeyError, "no #{name} on the shelf" }
    end

    def low_stock(threshold_grams = 100)
      @items.values.select { |item| item.low?(threshold_grams) }
    end

    def total_grams
      @items.values.sum(&:grams)
    end
  end
end
