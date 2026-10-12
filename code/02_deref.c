/* 02_deref.c -- reading and writing THROUGH a pointer
 * build: gcc -Wall -std=c11 02_deref.c -o 02 && ./02               */
#include <stdio.h>

int main(void)
{
    int x = 10;
    int y = 7;
    int *p = &x;

    *p = 99;                  /* write through p  -> changes x      */
    printf("x = %d\n", x);

    (*p)++;                   /* ++ the pointee   -> x becomes 100  */
    printf("x = %d\n", x);

    p = &y;                   /* re-point p: it now aims at y       */
    *p = 123;
    printf("x = %d, y = %d\n", x, y);
    return 0;
}
