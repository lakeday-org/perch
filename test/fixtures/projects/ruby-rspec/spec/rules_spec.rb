require "spec_helper"

RSpec.describe Rota::Rules do
  def shift(person, day, starts, ends)
    Rota::Shift.new(person, day, starts, ends)
  end

  it "passes a reasonable week" do
    expect(Rota::Rules.check([shift("ana", 1, 9, 17), shift("ana", 2, 9, 17)])).to be_empty
  end

  it "flags more than ten hours in a day" do
    problems = Rota::Rules.check([shift("ana", 1, 6, 18)])
    expect(problems).to include(a_string_matching(/12h on day 1/))
  end

  it "flags a night shift followed by an early start" do
    expect(Rota::Rules.rest_broken?([shift("ana", 1, 22, 30), shift("ana", 2, 8, 12)])).to be(true)
  end
end
