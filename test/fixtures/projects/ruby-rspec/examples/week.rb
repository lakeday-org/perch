# A week's rota for two people, printed as a table with the rule breaches after it.
require_relative "../lib/rota"

schedule = Rota::Schedule.new
schedule.assign("ana", 0, 9, 17)
schedule.assign("ben", 0, 12, 20)
schedule.assign("ana", 1, 22, 30)
schedule.assign("ana", 2, 8, 12)

puts Rota::Formatter.table(schedule)
puts
puts schedule.problems
