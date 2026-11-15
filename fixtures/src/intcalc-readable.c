/* Same CLI as intcalc, with explicit signed 32-bit wraparound. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int parse_operand(const char *text, int32_t *operand) {
    char *end;
    errno = 0;
    long long value = strtoll(text, &end, 10);

    if (errno != 0 || end == text || *end != '\0') {
        return 0;
    }
    if (value < INT32_MIN || value > INT32_MAX) {
        return 0;
    }

    *operand = (int32_t)value;
    return 1;
}

static double add_and_scale(int32_t left, int32_t right) {
    const int64_t wrap_modulus = INT64_C(1) << 32;
    int64_t sum = (int64_t)left + (int64_t)right;

    if (sum > INT32_MAX) {
        sum -= wrap_modulus;
    } else if (sum < INT32_MIN) {
        sum += wrap_modulus;
    }

    return (double)sum / 3.0;
}

int main(int argc, char **argv) {
    int32_t left;
    int32_t right;

    if (argc == 3 &&
        parse_operand(argv[1], &left) &&
        parse_operand(argv[2], &right)) {
        double scaled = add_and_scale(left, right);
        printf("%.2f\n", scaled);
        return 0;
    }

    fputs("usage: intcalc LEFT RIGHT\n", stderr);
    return 2;
}
