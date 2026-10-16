require_relative "shift"
require_relative "rules"

module Rota
  class Schedule
    attr_reader :shifts

    def initialize
      @shifts = []
    end

    def assign(person, day, starts, ends)
      shift = Shift.new(person, day, starts, ends)
      clash = @shifts.find { |other| other.person == person && other.overlaps?(shift) }
      raise ArgumentError, "#{person} is already on at that time" if clash
      @shifts << shift
      shift
    end

    def hours_for(person)
      @shifts.select { |shift| shift.person == person }.sum(&:hours)
    end

    def on_duty(day, hour)
      @shifts.select { |shift| shift.day == day && shift.starts <= hour && hour < shift.ends }.map(&:person)
    end

    def problems
      Rules.check(@shifts)
    end
  end
end
