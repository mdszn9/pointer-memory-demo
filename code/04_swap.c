/* 04_swap.c -- call by value vs. call by reference
 * build: gcc -Wall -std=c11 04_swap.c -o 04 && ./04                */
#include <stdio.h>

void swap_val(int a, int b)
{
    int t = a; a = b; b = t;  /* swaps the COPIES only              */
}

void swap_ptr(int *a, int *b)
{
    int t = *a; *a = *b; *b = t;   /* swaps what they POINT TO      */
}

int main(void)
{
    int x = 1, y = 2;

    swap_val(x, y);
    printf("after swap_val : x=%d y=%d\n", x, y);

    swap_ptr(&x, &y);
    printf("after swap_ptr : x=%d y=%d\n", x, y);
    return 0;
}
