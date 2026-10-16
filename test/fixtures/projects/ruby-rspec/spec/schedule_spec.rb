require "spec_helper"

RSpec.describe Rota::Schedule do
  let(:schedule) { Rota::Schedule.new }

  before do
    schedule.assign("ana", 1, 9, 17)
    schedule.assign("ben", 1, 12, 20)
  end

  it "adds up a person's hours" do
    schedule.assign("ana", 2, 9, 13)
    expect(schedule.hours_for("ana")).to eq(12)
  end

  it "refuses a second shift at the same time" do
    expect { schedule.assign("ana", 1, 16, 18) }.to raise_error(ArgumentError, /already on/)
  end

  it "lists who is on duty at an hour" do
    expect(schedule.on_duty(1, 13)).to contain_exactly("ana", "ben")
  end

  context "when the rules are broken" do
    before do
      schedule.assign("ana", 1, 22, 30)
      schedule.assign("ana", 2, 8, 12)
    end

    it "reports the problems" do
      expect(schedule.problems).to include(a_string_matching(/night shift/))
    end

    it "asks the rules once for the whole schedule" do
      allow(Rota::Rules).to receive(:check).and_return(["too many hours"])
      expect(schedule.problems).to eq(["too many hours"])
    end
  end
end
