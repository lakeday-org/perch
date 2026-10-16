local Duration = require "tempo.duration"

local Clock = {}
Clock.__index = Clock

function Clock.new(now)
  return setmetatable({ now = now or 0 }, Clock)
end

function Clock:advance(duration)
  self.now = self.now + duration.seconds
  return self.now
end

function Clock:since(moment)
  if moment > self.now then
    error("that is in the future")
  end
  return Duration.new(self.now - moment)
end

return Clock
