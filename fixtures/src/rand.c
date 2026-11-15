/* Fixture: outputs one random value to exercise use of external state. */
#include <stdio.h>
#include <sys/random.h>

static int read_random(unsigned int *value) {
    return getrandom(value, sizeof(*value), 0) == sizeof(*value);
}

int main(void) {
    unsigned int value;
    if (!read_random(&value)) {
        fputs("rand: entropy unavailable\n", stderr);
        return 1;
    }
    printf("sample=%08x\n", value);
    return 0;
}
