# Build every example:  make        Run one:  ./01
# Clean up:             make clean
CC      := gcc
CFLAGS  := -Wall -Wextra -std=c11 -g

SRCS := $(wildcard 0*.c)
BINS := $(patsubst %.c,%,$(SRCS))

all: $(BINS)

%: %.c
	$(CC) $(CFLAGS) $< -o $@

run: all
	@for b in $(BINS); do echo "=== $$b ==="; ./$$b; echo; done

clean:
	$(RM) $(BINS)
	$(RM) -r $(addsuffix .dSYM,$(BINS))

.PHONY: all run clean
