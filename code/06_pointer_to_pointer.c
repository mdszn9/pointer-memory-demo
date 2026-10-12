/* 06_pointer_to_pointer.c -- two levels of indirection
 * build: gcc -Wall -std=c11 06_pointer_to_pointer.c -o 06 && ./06  */
#include <stdio.h>

int main(void)
{
    int   x  = 5;
    int   y  = 9;
    int  *p  = &x;
    int **pp = &p;            /* pp points at the pointer p         */

    printf("x = %d   *p = %d   **pp = %d\n", x, *p, **pp);

    **pp = 50;                /* two hops: pp -> p -> x             */
    printf("x = %d\n", x);

    *pp = &y;                 /* one hop: changes p itself          */
    printf("*p = %d  (p now aims at y)\n", *p);
    return 0;
}
