# Builds x86-64 ELF fixtures in a pinned gcc image (works on Apple Silicon via emulation). Run: make -C fixtures
GCC_IMAGE ?= gcc:13@sha256:8c0fe724784c6d617cb582f79ddaf5dd2233aaba2fb7a14e0b9d03348fea8088
all:
	mkdir -p bin
	docker run --rm --platform linux/amd64 -v "$(CURDIR)":/f -w /f $(GCC_IMAGE) sh -c 'for s in src/*.c; do n=$$(basename $$s .c); gcc -O1 -o bin/$$n $$s && cp bin/$$n bin/$$n.stripped && strip bin/$$n.stripped; done'
