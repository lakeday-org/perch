local Duration = require "tempo.duration"

describe("Duration", function()
  it("parses hours and minutes into seconds", function()
    assert.are.equal(5400, Duration.parse("1h30m").seconds)
  end)

  it("rejects a unit it does not know", function()
    assert.has_error(function() Duration.parse("3w") end, "unknown unit w")
  end)

  it("rejects a negative length", function()
    assert.has_error(function() Duration.new(-1) end)
  end)

  describe("arithmetic", function()
    local hour

    before_each(function()
      hour = Duration.new(3600)
    end)

    it("adds two durations", function()
      assert.are.equal(5400, hour:add(Duration.new(1800)).seconds)
    end)

    it("compares lengths", function()
      assert.is_true(hour:longer_than(Duration.new(60)))
      assert.is_false(Duration.new(60):longer_than(hour))
    end)

    it("converts to minutes", function()
      assert.are.equal(60, hour:minutes())
    end)
  end)
end)
