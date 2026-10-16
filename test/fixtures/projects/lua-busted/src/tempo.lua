local Duration = require "tempo.duration"
local Clock = require "tempo.clock"
local format = require "tempo.format"

local tempo = { _VERSION = "0.2.0" }

function tempo.parse(text)
  return Duration.parse(text)
end

function tempo.describe(text)
  return format.human(Duration.parse(text))
end

function tempo.stopwatch(now)
  return Clock.new(now)
end

return tempo
