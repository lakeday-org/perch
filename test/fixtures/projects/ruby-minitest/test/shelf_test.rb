require "test_helper"

class ShelfTest < Minitest::Test
  def setup
    @shelf = Pantry::Shelf.new
    @shelf.add(Pantry::Item.new("rice", 2, "kg"))
  end

  def test_add_merges_the_same_item
    @shelf.add(Pantry::Item.new("rice", 500))
    assert_equal 2500, @shelf.find("rice").grams
  end

  def test_find_raises_for_a_missing_item
    assert_raises(KeyError) { @shelf.find("beans") }
  end

  def test_low_stock_lists_items_under_the_threshold
    @shelf.add(Pantry::Item.new("salt", 50))
    assert_equal ["salt"], @shelf.low_stock.map(&:name)
  end

  def test_stock_builds_a_shelf
    shelf = Pantry.stock([["rice", 1, "kg"], ["salt", 50, "g"]])
    assert_equal 1050, shelf.total_grams
  end
end
