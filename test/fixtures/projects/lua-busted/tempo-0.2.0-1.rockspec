package = "tempo"
version = "0.2.0-1"
source = {
  url = "git+https://example.com/acme/tempo.git",
  tag = "v0.2.0",
}
description = {
  summary = "Durations, a clock, and ways to print them",
  license = "MIT",
}
dependencies = {
  "lua >= 5.3",
}
build = {
  type = "builtin",
  modules = {
    ["tempo"] = "src/tempo.lua",
    ["tempo.duration"] = "src/tempo/duration.lua",
    ["tempo.clock"] = "src/tempo/clock.lua",
    ["tempo.format"] = "src/tempo/format.lua",
  },
}
