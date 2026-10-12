/* 03_arithmetic.c -- pointer arithmetic is measured in ELEMENTS
 * build: gcc -Wall -std=c11 03_arithmetic.c -o 03 && ./03          */
#include <stdio.h>

int main(void)
{
    int  a[5] = {10, 20, 30, 40, 50};
    int *p    = a;            /* array name decays to &a[0]         */

    printf("p = %p  *p = %d\n", (void *)p, *p);
    p++;                      /* +1 element = +4 bytes              */
    printf("p = %p  *p = %d\n", (void *)p, *p);
    p += 2;                   /* +2 elements = +8 bytes             */
    printf("p = %p  *p = %d\n", (void *)p, *p);

    printf("p[-1] = %d   a[3] = %d   *(a+3) = %d\n", p[-1], a[3], *(a + 3));
    printf("p - a = %ld elements\n", (long)(p - a));
    return 0;
}
