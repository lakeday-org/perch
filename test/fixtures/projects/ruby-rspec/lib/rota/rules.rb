module Rota
  module Rules
    MAX_HOURS_PER_DAY = 10
    MAX_HOURS_PER_WEEK = 48

    def self.check(shifts)
      problems = []
      shifts.group_by(&:person).each do |person, own|
        weekly = own.sum(&:hours)
        problems << "#{person} works #{weekly}h, over #{MAX_HOURS_PER_WEEK}" if weekly > MAX_HOURS_PER_WEEK
        own.group_by(&:day).each do |day, daily|
          hours = daily.sum(&:hours)
          problems << "#{person} works #{hours}h on day #{day}" if hours > MAX_HOURS_PER_DAY
        end
        problems << "#{person} has a night shift before an early start" if rest_broken?(own)
      end
      problems
    end

    def self.rest_broken?(shifts)
      ordered = shifts.sort_by { |shift| [shift.day, shift.starts] }
      ordered.each_cons(2).any? { |before, after| before.night? && after.day == before.day + 1 && after.starts < 12 }
    end
  end
end
