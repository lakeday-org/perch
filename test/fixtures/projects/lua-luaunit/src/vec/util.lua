local util = {}

function util.near(a, b, tolerance)
  tolerance = tolerance or 1e-9
  return math.abs(a - b) <= tolerance
end

function util.clamp(value, low, high)
  if value < low then
    return low
  elseif value > high then
    return high
  end
  return value
end

return util
