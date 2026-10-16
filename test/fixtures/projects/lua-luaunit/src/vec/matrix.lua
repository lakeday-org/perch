local Vector = require("vec.vector")

local Matrix = {}
Matrix.__index = Matrix

function Matrix.new(a, b, c, d)
  return setmetatable({ a = a, b = b, c = c, d = d }, Matrix)
end

function Matrix.identity()
  return Matrix.new(1, 0, 0, 1)
end

function Matrix.rotation(radians)
  local cos, sin = math.cos(radians), math.sin(radians)
  return Matrix.new(cos, -sin, sin, cos)
end

function Matrix:apply(vector)
  return Vector.new(self.a * vector.x + self.b * vector.y, self.c * vector.x + self.d * vector.y)
end

function Matrix:multiply(other)
  return Matrix.new(
    self.a * other.a + self.b * other.c, self.a * other.b + self.b * other.d,
    self.c * other.a + self.d * other.c, self.c * other.b + self.d * other.d)
end

function Matrix:determinant()
  return self.a * self.d - self.b * self.c
end

function Matrix:inverse()
  local det = self:determinant()
  if det == 0 then
    return nil
  end
  return Matrix.new(self.d / det, -self.b / det, -self.c / det, self.a / det)
end

return Matrix
