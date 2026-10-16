local lu = require("luaunit")
local Matrix = require("vec.matrix")
local Vector = require("vec.vector")
local util = require("vec.util")

TestMatrix = {}

function TestMatrix:setUp()
  self.quarter = Matrix.rotation(math.pi / 2)
end

function TestMatrix:testIdentityLeavesAVectorAlone()
  local v = Matrix.identity():apply(Vector.new(2, 3))
  lu.assertEquals({ v.x, v.y }, { 2, 3 })
end

function TestMatrix:testRotationTurnsAQuarter()
  local v = self.quarter:apply(Vector.new(1, 0))
  lu.assertTrue(util.near(v.x, 0) and util.near(v.y, 1))
end

function TestMatrix:testInverseUndoesTheRotation()
  local back = self.quarter:multiply(self.quarter:inverse())
  lu.assertTrue(util.near(back:determinant(), 1))
end

function TestMatrix:testASingularMatrixHasNoInverse()
  lu.assertNil(Matrix.new(1, 2, 2, 4):inverse())
end

function testClampKeepsAValueInRange()
  lu.assertEquals(util.clamp(15, 0, 10), 10)
  lu.assertEquals(util.clamp(-1, 0, 10), 0)
  lu.assertEquals(util.clamp(5, 0, 10), 5)
end

os.exit(lu.LuaUnit.run())
