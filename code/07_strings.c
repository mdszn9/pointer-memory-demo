/* 07_strings.c -- a char array you may write vs. a literal you may not
 * build: gcc -Wall -std=c11 07_strings.c -o 07 && ./07             */
#include <stdio.h>

int main(void)
{
    char        buf[6] = "COMS";   /* a modifiable COPY on the stack */
    const char *lit    = "OS";     /* pointer into read-only data    */

    printf("buf = \"%s\"\n", buf);
    buf[0] = 'R';                  /* legal: buf is an array         */
    printf("buf = \"%s\"\n", buf);

    /* lit[0] = 'X';   <-- undefined behaviour: read-only memory     */

    for (const char *s = buf; *s != '\0'; s++)   /* walk to the NUL  */
        printf("[%c]", *s);
    printf("\nlit = \"%s\"\n", lit);
    return 0;
}
