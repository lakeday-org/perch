project('parse', 'c', version: '0.3.0', default_options: ['c_std=c11', 'warning_level=2'])

inc = include_directories('include')
parse_lib = static_library('parse', 'src/amount.c', 'src/fields.c', 'src/posting.c', include_directories: inc)

criterion = dependency('criterion', required: get_option('tests'))
if criterion.found()
  foreach name : ['amount', 'posting']
    exe = executable(name + '_test', 'tests/' + name + '_test.c', include_directories: inc, link_with: parse_lib, dependencies: criterion)
    test(name, exe)
  endforeach
endif

if get_option('examples')
  executable('parse_line', 'examples/parse_line.c', include_directories: inc, link_with: parse_lib)
endif
