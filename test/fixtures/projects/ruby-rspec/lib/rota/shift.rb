module Rota
  # One person's shift on one day, in whole hours. An end past 24 runs into the next morning.
  class Shift
    attr_reader :person, :day, :starts, :ends

    def initialize(person, day, starts, ends)
      raise ArgumentError, "a shift ends after it starts" unless ends > starts
      @person = person
      @day = day
      @starts = starts
      @ends = ends
    end

    def hours
      ends - starts
    end

    def overlaps?(other)
      day == other.day && starts < other.ends && other.starts < ends
    end

    def night?
      starts >= 22 || ends <= 6
    end
  end
end
