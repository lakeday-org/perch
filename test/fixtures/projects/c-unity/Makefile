CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Iinclude
UNITY_DIR ?= vendor/unity/src

SRC := src/ring.c src/crc.c src/filter.c
TESTS := test/test_ring test/test_crc test/test_filter

all: libfirmware.a

libfirmware.a: $(SRC:.c=.o)
	$(AR) rcs $@ $^

test: $(TESTS)
	@for t in $(TESTS); do ./$$t || exit 1; done

test/test_%: test/test_%.c $(SRC) $(UNITY_DIR)/unity.c
	$(CC) $(CFLAGS) -I$(UNITY_DIR) -o $@ $^

examples/blink: examples/blink.c $(SRC)
	$(CC) $(CFLAGS) -o $@ $^

clean:
	rm -f src/*.o libfirmware.a $(TESTS) examples/blink

.PHONY: all test clean
