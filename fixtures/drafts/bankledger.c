/* bankledger: nightly batch posting for a small deposit ledger.
 *
 * Reads fixed-width transaction records from stdin, posts them to the account table,
 * and prints a posting journal, control totals and a trial balance.
 *
 * Record layout (30 columns, one record per line):
 *
 *   01-02  transaction code   OP open, DP deposit, WD withdrawal, XF transfer, ME month end
 *   03-10  account number     8 digits, the last one is a check digit
 *   11-18  other account      receiving account for XF, zeros otherwise
 *   19-29  amount             9(9)V99, in cents
 *   30     account class      S savings or C checking (OP only), blank otherwise
 *
 * Status codes in the journal: 00 posted, 11 bad record, 12 unknown code, 13 bad class,
 * 21 bad check digit, 22 no such account, 23 account exists, 24 same account,
 * 31 balance limit, 32 insufficient funds, 33 too many withdrawals, 34 table full.
 *
 * Exit status: 0 when every record posted, 4 when at least one was rejected.
 */
#include <stdio.h>
#include <string.h>

#define RECORD_LENGTH 30
#define MAX_ACCOUNTS 64
#define MAX_BALANCE 999999999999LL   /* 9,999,999,999.99 */
#define OVERDRAFT_LIMIT 50000LL      /* checking may go 500.00 below zero */
#define OVERDRAFT_FEE 3500LL
#define SAVINGS_WITHDRAWALS 6        /* per month */
#define MAINTENANCE_FLOOR 100000LL   /* checking below 1,000.00 pays the fee */
#define MAINTENANCE_FEE 500LL
#define EDIT_WIDTH 20

struct account {
    long long number;
    long long balance;
    long long interest_paid;
    int withdrawals;
    char class;
};

struct account accounts[MAX_ACCOUNTS];
int account_count;

/* Unsigned numeric field. Returns -1 when a column is not a digit. */
long long numeric_field(const char *record, int start, int length) {
    long long value = 0;
    int i;

    for (i = start; i < start + length; i++) {
        if (record[i] < '0' || record[i] > '9') return -1;
        value = value * 10 + (record[i] - '0');
    }
    return value;
}

/* Weighted modulus 11 check over the first seven digits. */
int account_check(long long number) {
    long long body = number / 10;
    int weight = 2;
    int sum = 0;

    if (number < 10000000LL || number > 99999999LL) return 0;
    while (body > 0) {
        sum += (int)(body % 10) * weight;
        weight = weight == 7 ? 2 : weight + 1;
        body /= 10;
    }
    return (11 - sum % 11) % 10 == number % 10;
}

struct account *find_account(long long number) {
    int i;

    for (i = 0; i < account_count; i++) {
        if (accounts[i].number == number) return &accounts[i];
    }
    return NULL;
}

int open_account(long long number, char class, long long deposit) {
    struct account *account;

    if (class != 'S' && class != 'C') return 13;
    if (find_account(number) != NULL) return 23;
    if (account_count == MAX_ACCOUNTS) return 34;
    account = &accounts[account_count++];
    account->number = number;
    account->balance = deposit;
    account->interest_paid = 0;
    account->withdrawals = 0;
    account->class = class;
    return 0;
}

int post_deposit(struct account *account, long long amount) {
    if (account->balance + amount > MAX_BALANCE) return 31;
    account->balance += amount;
    return 0;
}

/* Savings never go negative and allow a few withdrawals a month.
 * Checking may overdraw up to the limit, and each overdrawing withdrawal costs a fee. */
int post_withdrawal(struct account *account, long long amount) {
    long long after = account->balance - amount;

    if (account->class == 'S') {
        if (account->withdrawals >= SAVINGS_WITHDRAWALS) return 33;
        if (after < 0) return 32;
    } else if (after < 0) {
        after -= OVERDRAFT_FEE;
        if (after < -OVERDRAFT_LIMIT) return 32;
    }
    account->balance = after;
    account->withdrawals++;
    return 0;
}

int post_transfer(struct account *from, struct account *to, long long amount) {
    struct account before = *from;
    int status;

    if (from == to) return 24;
    status = post_withdrawal(from, amount);
    if (status != 0) return status;
    status = post_deposit(to, amount);
    if (status != 0) *from = before;
    return status;
}

/* One month of interest at a yearly rate in basis points, rounded half up.
 * Overdrawn balances are charged 18%. */
long long monthly_interest(const struct account *account) {
    long long balance = account->balance;
    long long rate;

    if (balance < 0) return -((-balance * 1800 + 60000) / 120000);
    if (account->class == 'S') {
        if (balance < 100000LL) rate = 150;
        else if (balance < 1000000LL) rate = 275;
        else rate = 410;
    } else {
        rate = balance >= 500000LL ? 50 : 0;
    }
    return (balance * rate + 60000) / 120000;
}

/* Credits interest, charges the checking maintenance fee and resets the withdrawal counters. */
int month_end(void) {
    int i;

    for (i = 0; i < account_count; i++) {
        struct account *account = &accounts[i];
        long long interest = monthly_interest(account);

        if (account->balance + interest <= MAX_BALANCE) {
            account->balance += interest;
            account->interest_paid += interest;
        }
        if (account->class == 'C' && account->balance < MAINTENANCE_FLOOR) account->balance -= MAINTENANCE_FEE;
        account->withdrawals = 0;
    }
    return account_count;
}

/* Edits cents as a right-aligned amount with thousands separators; negative amounts end in DB. */
void edit_amount(long long cents, char *out) {
    char digits[24];
    long long magnitude = cents < 0 ? -cents : cents;
    int count = sprintf(digits, "%lld", magnitude / 100);
    int lead = EDIT_WIDTH - 3 - count - (count - 1) / 3;
    int pos = 0;
    int i;

    while (pos < lead) out[pos++] = ' ';
    for (i = 0; i < count; i++) {
        out[pos++] = digits[i];
        if (i != count - 1 && (count - 1 - i) % 3 == 0) out[pos++] = ',';
    }
    out[pos++] = '.';
    out[pos++] = (char)('0' + magnitude % 100 / 10);
    out[pos++] = (char)('0' + magnitude % 10);
    strcpy(out + pos, cents < 0 ? " DB" : "");
}

void print_trial_balance(void) {
    char balance[EDIT_WIDTH + 8];
    char interest[EDIT_WIDTH + 8];
    long long total = 0;
    int i;

    printf("TRIAL BALANCE\n");
    for (i = 0; i < account_count; i++) {
        edit_amount(accounts[i].balance, balance);
        edit_amount(accounts[i].interest_paid, interest);
        printf("%08lld %c %s\n", accounts[i].number, accounts[i].class, balance);
        printf("           INTEREST %s\n", interest);
        total += accounts[i].balance;
    }
    edit_amount(total, balance);
    printf("ACCOUNTS %d\n", account_count);
    printf("TOTAL      %s\n", balance);
}

int main(void) {
    char line[128];
    char edited[EDIT_WIDTH + 8];
    long long posted_amount = 0;
    int sequence = 0;
    int posted = 0;
    int rejected = 0;

    printf("POSTING JOURNAL\n");
    while (fgets(line, sizeof line, stdin) != NULL) {
        long long number = 0;
        long long other = 0;
        long long amount = 0;
        int status = 0;
        size_t length = strcspn(line, "\r\n");

        line[length] = '\0';
        sequence++;
        if (length != RECORD_LENGTH) {
            status = 11;
        } else if (memcmp(line, "ME", 2) == 0) {
            month_end();
        } else {
            number = numeric_field(line, 2, 8);
            other = numeric_field(line, 10, 8);
            amount = numeric_field(line, 18, 11);
            if (number < 0 || other < 0 || amount < 0) {
                status = 11;
            } else if (!account_check(number)) {
                status = 21;
            } else if (memcmp(line, "OP", 2) == 0) {
                status = open_account(number, line[29], amount);
            } else {
                struct account *account = find_account(number);

                if (account == NULL) {
                    status = 22;
                } else if (memcmp(line, "DP", 2) == 0) {
                    status = post_deposit(account, amount);
                } else if (memcmp(line, "WD", 2) == 0) {
                    status = post_withdrawal(account, amount);
                } else if (memcmp(line, "XF", 2) == 0) {
                    struct account *target = find_account(other);

                    if (!account_check(other)) status = 21;
                    else if (target == NULL) status = 22;
                    else status = post_transfer(account, target, amount);
                } else {
                    status = 12;
                }
            }
        }
        if (status == 0) {
            posted++;
            posted_amount += amount;
        } else {
            rejected++;
        }
        edit_amount(amount < 0 ? 0 : amount, edited);
        printf("%06d %.2s %08lld %s %02d\n", sequence, line, number < 0 ? 0 : number, edited, status);
    }
    edit_amount(posted_amount, edited);
    printf("RECORDS %d POSTED %d REJECTED %d\n", sequence, posted, rejected);
    printf("POSTED     %s\n", edited);
    print_trial_balance();
    return rejected ? 4 : 0;
}
