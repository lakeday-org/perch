package = "vec"
version = "0.1.0-1"
source = {
  url = "git+https://example.com/acme/vec.git",
  tag = "v0.1.0",
}
description = {
  summary = "Two-dimensional vectors and the matrices that move them",
  license = "MIT",
}
dependencies = {
  "lua >= 5.1",
}
build = {
  type = "builtin",
  modules = {
    ["vec.vector"] = "src/vec/vector.lua",
    ["vec.matrix"] = "src/vec/matrix.lua",
    ["vec.util"] = "src/vec/util.lua",
  },
}
