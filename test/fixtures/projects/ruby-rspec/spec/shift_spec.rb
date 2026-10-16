require "spec_helper"

RSpec.describe Rota::Shift do
  subject(:shift) { Rota::Shift.new("ana", 1, 9, 17) }

  it "lasts from its start to its end" do
    expect(shift.hours).to eq(8)
  end

  it "rejects a shift that ends before it starts" do
    expect { Rota::Shift.new("ana", 1, 17, 9) }.to raise_error(ArgumentError)
  end

  describe "#overlaps?" do
    it "overlaps a shift on the same day sharing an hour" do
      expect(shift.overlaps?(Rota::Shift.new("ben", 1, 16, 20))).to be(true)
    end

    it "does not overlap a shift on another day" do
      expect(shift.overlaps?(Rota::Shift.new("ben", 2, 9, 17))).to be(false)
    end
  end

  describe "#night?" do
    it "is a night shift when it starts late" do
      expect(Rota::Shift.new("ana", 1, 22, 30).night?).to be(true)
    end
  end
end
