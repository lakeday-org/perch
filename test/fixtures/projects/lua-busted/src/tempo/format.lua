local M = {}

local function pad(n)
  if n < 10 then
    return "0" .. n
  end
  return tostring(n)
end

function M.clock(duration)
  local total = math.floor(duration.seconds)
  local hours = math.floor(total / 3600)
  local minutes = math.floor((total % 3600) / 60)
  local seconds = total % 60
  if hours > 0 then
    return hours .. ":" .. pad(minutes) .. ":" .. pad(seconds)
  end
  return minutes .. ":" .. pad(seconds)
end

function M.human(duration)
  local minutes = duration:minutes()
  if minutes < 1 then
    return "under a minute"
  elseif minutes < 60 then
    return math.floor(minutes) .. " min"
  end
  return string.format("%.1f h", minutes / 60)
end

return M
