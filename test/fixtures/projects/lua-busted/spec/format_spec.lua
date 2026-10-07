local Duration = require "tempo.duration"
local format = require "tempo.format"

describe("format", function()
  describe("clock", function()
    it("writes minutes and seconds", function()
      assert.are.equal("5:09", format.clock(Duration.new(309)))
    end)

    it("adds hours when there are any", function()
      assert.are.equal("2:00:05", format.clock(Duration.new(7205)))
    end)
  end)

  describe("human", function()
    it("rounds minutes down", function()
      assert.are.equal("45 min", format.human(Duration.new(2730)))
    end)

    it("switches to hours after sixty minutes", function()
      assert.are.equal("1.5 h", format.human(Duration.new(5400)))
    end)
  end)
end)
