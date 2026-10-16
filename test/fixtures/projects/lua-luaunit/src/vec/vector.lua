local util = require("vec.util")

local Vector = {}
Vector.__index = Vector

function Vector.new(x, y)
  return setmetatable({ x = x or 0, y = y or 0 }, Vector)
end

function Vector:add(other)
  return Vector.new(self.x + other.x, self.y + other.y)
end

function Vector:scale(factor)
  return Vector.new(self.x * factor, self.y * factor)
end

function Vector:length()
  return math.sqrt(self.x * self.x + self.y * self.y)
end

function Vector:normalized()
  local length = self:length()
  if length == 0 then
    error("the zero vector has no direction")
  end
  return self:scale(1 / length)
end

function Vector:equals(other)
  return util.near(self.x, other.x) and util.near(self.y, other.y)
end

return Vector
