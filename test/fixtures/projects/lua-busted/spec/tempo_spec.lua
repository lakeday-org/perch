local tempo = require "tempo"

describe("tempo", function()
  it("parses a duration", function()
    assert.are.equal(90, tempo.parse("1m30s").seconds)
  end)

  it("describes a duration in words", function()
    assert.are.equal("2 min", tempo.describe("2m"))
  end)

  describe("stopwatch", function()
    it("measures the time since a moment", function()
      local clock = tempo.stopwatch(100)
      clock:advance(tempo.parse("45s"))
      assert.are.equal(45, clock:since(100).seconds)
    end)

    it("refuses a moment in the future", function()
      local clock = tempo.stopwatch(100)
      assert.has_error(function() clock:since(200) end, "that is in the future")
    end)
  end)
end)
