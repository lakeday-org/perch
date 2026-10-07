require "test_helper"

describe Pantry::Recipe do
  let(:recipe) { Pantry::Recipe.new("risotto", serves: 2).needs("rice", 300).needs("stock", 500) }

  it "scales ingredients to the number served" do
    scaled = recipe.scaled(4)
    assert_equal [600, 1000], scaled.map(&:quantity)
  end

  describe "against a shelf" do
    let(:shelf) { Pantry.stock([["rice", 1, "kg"]]) }

    it "lists what the shelf lacks" do
      assert_equal ["stock"], recipe.missing_from(shelf)
    end
  end
end
