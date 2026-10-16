-- Usage: lua scripts/bench.lua   Times parsing a duration a hundred thousand times.
package.path = "./src/?.lua;" .. package.path
local Duration = require "tempo.duration"

local started = os.clock()
for _ = 1, 100000 do
  Duration.parse("1h30m15s")
end
print(string.format("parsed 100000 durations in %.2fs", os.clock() - started))
