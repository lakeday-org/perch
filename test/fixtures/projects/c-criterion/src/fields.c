#include <ctype.h>
#include <string.h>

#include "parse.h"

char *trim(char *text) {
  while (isspace((unsigned char)*text)) text++;
  size_t length = strlen(text);
  while (length > 0 && isspace((unsigned char)text[length - 1])) text[--length] = '\0';
  return text;
}

int split_fields(char *line, char **fields) {
  int count = 0;
  char *cursor = line;
  while (*cursor != '\0' && count < MAX_FIELDS) {
    while (isspace((unsigned char)*cursor)) cursor++;
    if (*cursor == '\0') break;
    fields[count++] = cursor;
    while (*cursor != '\0' && !isspace((unsigned char)*cursor)) cursor++;
    if (*cursor != '\0') *cursor++ = '\0';
  }
  return count;
}
