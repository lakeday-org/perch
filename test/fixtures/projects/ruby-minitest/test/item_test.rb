require "test_helper"

class ItemTest < Minitest::Test
  def setup
    @rice = Pantry::Item.new("rice", 2, "kg")
  end

  def test_grams_converts_the_unit
    assert_equal 2000, @rice.grams
  end

  def test_rejects_a_zero_quantity
    assert_raises(ArgumentError) { Pantry::Item.new("rice", 0) }
  end

  def test_merge_adds_in_grams
    merged = @rice.merge(Pantry::Item.new("rice", 500))
    assert_equal 2500, merged.quantity
    assert_equal "g", merged.unit
  end

  def test_low_below_the_threshold
    assert Pantry::Item.new("salt", 50).low?
    refute @rice.low?
  end
end
