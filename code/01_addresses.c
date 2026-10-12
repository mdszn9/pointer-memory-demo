/* 01_addresses.c -- a variable, its address, and a pointer to it
 * build: gcc -Wall -std=c11 01_addresses.c -o 01 && ./01            */
#include <stdio.h>

int main(void)
{
    int  x = 42;
    int *p = &x;              /* p holds the ADDRESS of x */

    printf("x        = %d\n", x);
    printf("&x       = %p\n", (void *)&x);
    printf("p        = %p\n", (void *)p);
    printf("*p       = %d\n", *p);
    printf("sizeof x = %zu bytes\n", sizeof x);
    printf("sizeof p = %zu bytes\n", sizeof p);
    return 0;
}
