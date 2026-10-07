module Rota
  module Formatter
    DAYS = %w[Mon Tue Wed Thu Fri Sat Sun].freeze

    def self.line(shift)
      "#{DAYS[shift.day]} #{pad(shift.starts)}-#{pad(shift.ends)} #{shift.person}"
    end

    def self.table(schedule)
      schedule.shifts.sort_by { |shift| [shift.day, shift.starts] }.map { |shift| line(shift) }.join("\n")
    end

    def self.pad(hour)
      hour.to_s.rjust(2, "0")
    end
  end
end
