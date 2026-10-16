local lu = require("luaunit")
local Vector = require("vec.vector")

TestVector = {}

function TestVector:setUp()
  self.unit = Vector.new(3, 4)
end

function TestVector:testAddsComponentwise()
  local sum = self.unit:add(Vector.new(1, 1))
  lu.assertEquals({ sum.x, sum.y }, { 4, 5 })
end

function TestVector:testLengthIsEuclidean()
  lu.assertEquals(self.unit:length(), 5)
end

function TestVector:testNormalizedHasLengthOne()
  lu.assertTrue(self.unit:normalized():equals(Vector.new(0.6, 0.8)))
end

function TestVector:testZeroVectorCannotBeNormalized()
  lu.assertErrorMsgContains("no direction", function() Vector.new(0, 0):normalized() end)
end

os.exit(lu.LuaUnit.run())
