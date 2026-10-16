-- Turns a vector through the angle given in degrees: lua examples/rotate.lua 1 0 90
package.path = "./src/?.lua;" .. package.path
local Matrix = require("vec.matrix")
local Vector = require("vec.vector")

local x, y, degrees = tonumber(arg[1]), tonumber(arg[2]), tonumber(arg[3])
local turned = Matrix.rotation(math.rad(degrees)):apply(Vector.new(x, y))
print(string.format("(%.3f, %.3f)", turned.x, turned.y))
