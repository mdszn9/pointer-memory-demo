/* 05_heap.c -- malloc / free, and why you NULL the pointer afterwards
 * build: gcc -Wall -std=c11 05_heap.c -o 05 && ./05                */
#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    int  n   = 4;
    int *arr = malloc(n * sizeof *arr);    /* 16 bytes on the HEAP  */
    if (arr == NULL) return 1;

    for (int i = 0; i < n; i++)
        arr[i] = (i + 1) * 11;

    printf("arr[0]=%d  arr[3]=%d\n", arr[0], arr[3]);
    printf("arr  = %p   (points into the heap)\n", (void *)arr);
    printf("&arr = %p   (the pointer itself is on the stack)\n", (void *)&arr);

    free(arr);        /* the 16 bytes go back to the allocator      */
    arr = NULL;       /* ...so we refuse to keep a dangling pointer */
    return 0;
}
