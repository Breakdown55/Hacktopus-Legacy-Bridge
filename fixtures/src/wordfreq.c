/* wordfreq: reads stdin text, prints top-N word counts. usage: wordfreq [--top N]. Reads stopwords.txt from cwd if present. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#define MAXW 4096
typedef struct { char w[64]; int n; } E;
static E t[MAXW]; static int nt;
static char stop[MAXW][64]; static int ns;
static int cmp(const void *a, const void *b) {
  const E *x = a, *y = b;
  if (y->n != x->n) return y->n - x->n;
  return strcmp(x->w, y->w);
}
static int stopped(const char *w) { for (int i = 0; i < ns; i++) if (!strcmp(stop[i], w)) return 1; return 0; }
static void add(const char *w) {
  if (stopped(w)) return;
  for (int i = 0; i < nt; i++) if (!strcmp(t[i].w, w)) { t[i].n++; return; }
  if (nt < MAXW) { strncpy(t[nt].w, w, 63); t[nt++].n = 1; }
}
int main(int argc, char **argv) {
  int top = 10;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--top") && i + 1 < argc) { top = atoi(argv[++i]); if (top < 1 || top > 1000) { fprintf(stderr, "usage: wordfreq [--top N]\n"); return 2; } }
    else { fprintf(stderr, "usage: wordfreq [--top N]\n"); return 2; }
  }
  FILE *f = fopen("stopwords.txt", "r");
  if (f) { while (ns < MAXW && fscanf(f, "%63s", stop[ns]) == 1) ns++; fclose(f); }
  char w[64]; int len = 0, c;
  while ((c = getchar()) != EOF) {
    if (isalpha(c)) { if (len < 63) w[len++] = tolower(c); }
    else if (len) { w[len] = 0; add(w); len = 0; }
  }
  if (len) { w[len] = 0; add(w); }
  qsort(t, nt, sizeof(E), cmp);
  for (int i = 0; i < nt && i < top; i++) printf("%s %d\n", t[i].w, t[i].n);
  return 0;
}
