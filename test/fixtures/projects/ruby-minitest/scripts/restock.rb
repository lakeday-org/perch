#!/usr/bin/env ruby
# Usage: scripts/restock.rb rice 2 kg salt 50 g   Prints what is running low after stocking the given items.
require_relative "../lib/pantry"

shelf = Pantry.stock(ARGV.each_slice(3).map { |name, quantity, unit| [name, Float(quantity), unit] })
shelf.low_stock.each { |item| puts "#{item.name}: #{item.grams}g" }
