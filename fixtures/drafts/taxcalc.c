/* taxcalc: small tax calculator. Money is handled in cents and rates in basis points, so results are exact.
 *
 *   taxcalc income   AMOUNT            progressive income tax on a yearly amount
 *   taxcalc withhold AMOUNT PERIODS    income tax spread over pay periods
 *   taxcalc sales    AMOUNT RATE       sales tax added on top of a net price
 *   taxcalc vat      AMOUNT RATE       VAT contained in a gross price
 *
 * AMOUNT is like 1234.56, RATE is a percentage like 8.25. Exit status: 0 on success, 2 on bad input.
 */
#include <stdio.h>
#include <string.h>

#define MAX_AMOUNT_CENTS 99999999999LL /* 999,999,999.99 */
#define MAX_RATE_BP 10000LL            /* 100.00% */
#define BP_SCALE 10000LL

struct bracket {
    long long upper_cents; /* income up to here is taxed at rate_bp; -1 means no upper limit */
    long long rate_bp;
};

const struct bracket income_brackets[] = {
    {1000000LL, 0},    /* first 10,000.00 is tax free */
    {4000000LL, 1000}, /* 10% up to 40,000.00 */
    {9000000LL, 2200}, /* 22% up to 90,000.00 */
    {-1, 3500},        /* 35% above that */
};

/* Reads "123", "123.4" or "123.45" as hundredths. Returns 1 on success. */
int parse_decimal2(const char *text, long long limit, long long *out) {
    long long whole = 0;
    long long fraction = 0;
    int digits = 0;
    int decimals = 0;

    while (*text >= '0' && *text <= '9') {
        whole = whole * 10 + (*text - '0');
        if (whole > limit) return 0;
        text++;
        digits++;
    }
    if (digits == 0) return 0;
    if (*text == '.') {
        text++;
        while (*text >= '0' && *text <= '9' && decimals < 2) {
            fraction = fraction * 10 + (*text - '0');
            text++;
            decimals++;
        }
        if (decimals == 0) return 0;
        if (decimals == 1) fraction *= 10;
    }
    if (*text != '\0') return 0;
    whole = whole * 100 + fraction;
    if (whole > limit) return 0;
    *out = whole;
    return 1;
}

/* Reads a whole number between 1 and limit. Returns 1 on success. */
int parse_count(const char *text, long long limit, long long *out) {
    long long value = 0;
    const char *p = text;

    while (*p >= '0' && *p <= '9') {
        value = value * 10 + (*p - '0');
        if (value > limit) return 0;
        p++;
    }
    if (p == text || *p != '\0' || value < 1) return 0;
    *out = value;
    return 1;
}

/* Divides and rounds half away from zero. The divisor is always positive here. */
long long round_div(long long value, long long divisor) {
    long long quotient = value / divisor;
    long long rest = value % divisor;

    if (rest < 0) rest = -rest;
    if (rest * 2 >= divisor) quotient += value < 0 ? -1 : 1;
    return quotient;
}

/* Writes cents as "1234.56". */
void format_money(char *buffer, size_t size, long long cents) {
    const char *sign = "";

    if (cents < 0) {
        sign = "-";
        cents = -cents;
    }
    snprintf(buffer, size, "%s%lld.%02lld", sign, cents / 100, cents % 100);
}

/* Progressive tax: each slice of income is taxed at the rate of the bracket it falls in. */
long long income_tax_cents(long long income_cents) {
    long long tax = 0;
    long long lower = 0;
    size_t i;

    for (i = 0; i < sizeof income_brackets / sizeof income_brackets[0]; i++) {
        long long upper = income_brackets[i].upper_cents;
        long long slice;

        if (upper < 0 || upper > income_cents) upper = income_cents;
        slice = upper - lower;
        if (slice <= 0) break;
        tax += round_div(slice * income_brackets[i].rate_bp, BP_SCALE);
        lower = upper;
    }
    return tax;
}

int cmd_income(int argc, char **argv) {
    long long income, tax, rate_bp;
    char text[32];

    if (argc != 1 || !parse_decimal2(argv[0], MAX_AMOUNT_CENTS, &income)) return 2;
    tax = income_tax_cents(income);
    rate_bp = income > 0 ? round_div(tax * BP_SCALE, income) : 0;
    format_money(text, sizeof text, income);
    printf("taxable income: %s\n", text);
    format_money(text, sizeof text, tax);
    printf("income tax: %s\n", text);
    format_money(text, sizeof text, rate_bp);
    printf("effective rate: %s%%\n", text);
    format_money(text, sizeof text, income - tax);
    printf("net income: %s\n", text);
    return 0;
}

int cmd_withhold(int argc, char **argv) {
    long long income, periods, tax, each;
    char text[32];

    if (argc != 2 || !parse_decimal2(argv[0], MAX_AMOUNT_CENTS, &income)
        || !parse_count(argv[1], 366, &periods)) return 2;
    tax = income_tax_cents(income);
    each = round_div(tax, periods);
    format_money(text, sizeof text, each);
    printf("withholding per period: %s\n", text);
    format_money(text, sizeof text, each * periods);
    printf("withheld over %lld periods: %s\n", periods, text);
    format_money(text, sizeof text, tax - each * periods);
    printf("year-end adjustment: %s\n", text);
    return 0;
}

int cmd_sales(int argc, char **argv) {
    long long net, rate_bp, tax;
    char text[32];

    if (argc != 2 || !parse_decimal2(argv[0], MAX_AMOUNT_CENTS, &net)
        || !parse_decimal2(argv[1], MAX_RATE_BP, &rate_bp)) return 2;
    tax = round_div(net * rate_bp, BP_SCALE);
    format_money(text, sizeof text, net);
    printf("net price: %s\n", text);
    format_money(text, sizeof text, tax);
    printf("sales tax: %s\n", text);
    format_money(text, sizeof text, net + tax);
    printf("total due: %s\n", text);
    return 0;
}

int cmd_vat(int argc, char **argv) {
    long long gross, rate_bp, net;
    char text[32];

    if (argc != 2 || !parse_decimal2(argv[0], MAX_AMOUNT_CENTS, &gross)
        || !parse_decimal2(argv[1], MAX_RATE_BP, &rate_bp)) return 2;
    net = round_div(gross * BP_SCALE, BP_SCALE + rate_bp);
    format_money(text, sizeof text, gross);
    printf("gross price: %s\n", text);
    format_money(text, sizeof text, gross - net);
    printf("vat included: %s\n", text);
    format_money(text, sizeof text, net);
    printf("price before vat: %s\n", text);
    return 0;
}

struct command {
    const char *name;
    int (*run)(int argc, char **argv);
};

const struct command commands[] = {
    {"income", cmd_income},
    {"withhold", cmd_withhold},
    {"sales", cmd_sales},
    {"vat", cmd_vat},
};

const struct command *find_command(const char *name) {
    size_t i;

    for (i = 0; i < sizeof commands / sizeof commands[0]; i++) {
        if (strcmp(commands[i].name, name) == 0) return &commands[i];
    }
    return NULL;
}

void print_usage(void) {
    fputs("usage: taxcalc income AMOUNT\n"
          "       taxcalc withhold AMOUNT PERIODS\n"
          "       taxcalc sales AMOUNT RATE\n"
          "       taxcalc vat AMOUNT RATE\n", stderr);
}

int main(int argc, char **argv) {
    const struct command *command;
    int status;

    if (argc < 2 || (command = find_command(argv[1])) == NULL) {
        print_usage();
        return 2;
    }
    status = command->run(argc - 2, argv + 2);
    if (status == 2) print_usage();
    return status;
}
