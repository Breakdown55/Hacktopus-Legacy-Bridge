/* Fixture: signed 32-bit addition with wraparound, followed by formatted scaling. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int parse_input(const char *text, int32_t *out) {
    char *end;
    errno = 0;
    long long value = strtoll(text, &end, 10);
    if (errno || end == text || *end || value < INT32_MIN || value > INT32_MAX) return 0;
    *out = (int32_t)value;
    return 1;
}

static double calculate(int32_t left, int32_t right) {
    uint32_t wrapped = (uint32_t)left + (uint32_t)right;
    int64_t signed_value = wrapped <= INT32_MAX ? (int64_t)wrapped : (int64_t)wrapped - (INT64_C(1) << 32);
    return (double)signed_value / 3.0;
}

int main(int argc, char **argv) {
    int32_t left, right;
    if (argc != 3 || !parse_input(argv[1], &left) || !parse_input(argv[2], &right)) {
        fputs("usage: intcalc LEFT RIGHT\n", stderr);
        return 2;
    }
    printf("%.2f\n", calculate(left, right));
    return 0;
}
