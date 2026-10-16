require_relative "units"

module Pantry
  class Recipe
    Ingredient = Struct.new(:name, :quantity, :unit)

    attr_reader :title, :serves

    def initialize(title, serves: 2)
      @title = title
      @serves = serves
      @ingredients = []
    end

    def needs(name, quantity, unit = "g")
      @ingredients << Ingredient.new(name, quantity, unit)
      self
    end

    def scaled(to)
      factor = to.to_f / serves
      @ingredients.map { |i| Ingredient.new(i.name, (i.quantity * factor).round(2), i.unit) }
    end

    def missing_from(shelf)
      @ingredients.reject do |ingredient|
        item = shelf.find(ingredient.name) rescue nil
        item && item.grams >= Units.to_grams(ingredient.quantity, ingredient.unit)
      end.map(&:name)
    end
  end
end
