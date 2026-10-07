require_relative "pantry/units"
require_relative "pantry/item"
require_relative "pantry/shelf"
require_relative "pantry/recipe"

module Pantry
  VERSION = "0.3.0"

  # A shelf stocked from `[name, quantity, unit]` rows, the way the restock script reads them.
  def self.stock(entries)
    shelf = Shelf.new
    entries.each { |name, quantity, unit| shelf.add(Item.new(name, quantity, unit || "g")) }
    shelf
  end
end
