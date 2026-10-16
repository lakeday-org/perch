CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Iinclude
CHECK_LIBS := $(shell pkg-config --libs check 2>/dev/null || echo -lcheck)

SRC := src/money.c src/entry.c src/ledger.c
TESTS := tests/money_test.c tests/ledger_test.c tests/main.c

all: libledger.a

libledger.a: $(SRC:.c=.o)
	$(AR) rcs $@ $^

check: ledger_tests
	CK_VERBOSITY=normal ./ledger_tests

ledger_tests: $(SRC) $(TESTS)
	$(CC) $(CFLAGS) -Itests -o $@ $^ $(CHECK_LIBS)

ledger-import: tools/ledger_import.c $(SRC)
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f src/*.o libledger.a ledger_tests ledger-import

.PHONY: all check clean
