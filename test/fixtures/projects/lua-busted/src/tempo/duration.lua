local Duration = {}
Duration.__index = Duration

local UNITS = { s = 1, m = 60, h = 3600, d = 86400 }

function Duration.new(seconds)
  if type(seconds) ~= "number" or seconds < 0 then
    error("a duration is a non-negative number of seconds")
  end
  return setmetatable({ seconds = seconds }, Duration)
end

-- "1h30m" is ninety minutes; each number takes the unit written after it.
function Duration.parse(text)
  local total = 0
  for amount, unit in text:gmatch("(%d+)(%a)") do
    local factor = UNITS[unit]
    if not factor then
      error("unknown unit " .. unit)
    end
    total = total + tonumber(amount) * factor
  end
  return Duration.new(total)
end

function Duration:add(other)
  return Duration.new(self.seconds + other.seconds)
end

function Duration:minutes()
  return self.seconds / 60
end

function Duration:longer_than(other)
  return self.seconds > other.seconds
end

return Duration
