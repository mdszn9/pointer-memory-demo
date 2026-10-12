/* 08_hazards.c -- the four classic pointer bugs, side by side
 * build: gcc -Wall -std=c11 08_hazards.c -o 08 && ./08             */
#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    int *p = NULL;
    /* printf("%d\n", *p);   (1) dereferencing NULL -> segfault     */

    int *q = malloc(sizeof *q);
    *q = 5;
    free(q);
    /* *q = 6;               (2) dangling: the block is not ours    */

    int  a[3] = {1, 2, 3};
    int *r    = a + 3;       /* (3) one past the end: legal to FORM */
    /* printf("%d\n", *r);        ...illegal to DEREFERENCE          */

    int  uninit;
    int *u = &uninit;        /* (4) valid pointer, garbage pointee  */

    printf("p = %p (NULL)\n", (void *)p);
    printf("r = %p (one past a[2], do not deref)\n", (void *)r);
    printf("u = %p (points at an uninitialised int)\n", (void *)u);
    return 0;
}
