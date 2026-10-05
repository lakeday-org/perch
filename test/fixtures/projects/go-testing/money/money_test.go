package money

import "testing"

func TestAdd(t *testing.T) {
	sum, err := New(150, USD).Add(New(250, USD))
	if err != nil || sum.Minor != 400 {
		t.Fatalf("got %v, %v", sum, err)
	}
}

func TestAddRejectsMixedCurrencies(t *testing.T) {
	if _, err := New(1, USD).Add(New(1, EUR)); err == nil {
		t.Fatal("expected an error")
	}
}

func TestAllocate(t *testing.T) {
	cases := []struct {
		name  string
		minor int64
		parts int
		want  []int64
	}{
		{"even", 300, 3, []int64{100, 100, 100}},
		{"remainder to the first parts", 100, 3, []int64{34, 33, 33}},
		{"negative", -100, 3, []int64{-34, -33, -33}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := New(tc.minor, USD).Allocate(tc.parts)
			if err != nil {
				t.Fatal(err)
			}
			for i, part := range got {
				if part.Minor != tc.want[i] {
					t.Errorf("part %d: got %d, want %d", i, part.Minor, tc.want[i])
				}
			}
		})
	}
}

func TestAllocateRejectsZeroParts(t *testing.T) {
	if _, err := New(100, USD).Allocate(0); err == nil {
		t.Fatal("expected an error")
	}
}

func TestMinorUnits(t *testing.T) {
	t.Run("yen has none", func(t *testing.T) {
		if MinorUnits(JPY) != 0 {
			t.Fail()
		}
	})
	t.Run("dollars have two", func(t *testing.T) {
		if MinorUnits(USD) != 2 {
			t.Fail()
		}
	})
}

func TestParse(t *testing.T) {
	if _, err := Parse("XXX"); err == nil {
		t.Fatal("expected an error")
	}
	c, err := Parse("EUR")
	if err != nil || c != EUR {
		t.Fatalf("got %v, %v", c, err)
	}
}

func TestString(t *testing.T) {
	if got := New(1234, USD).String(); got != "12.34 USD" {
		t.Errorf("got %q", got)
	}
	if got := New(1234, JPY).String(); got != "1234 JPY" {
		t.Errorf("got %q", got)
	}
}
