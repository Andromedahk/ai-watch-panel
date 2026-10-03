#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef ZCODE_CONTEXT_TEST
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>
#endif

#define MAX_PROCARGS_BYTES (1024U * 1024U)
#define MAX_VALUE_BYTES 4096U
#define MAX_JSON_BYTES (16U * 1024U)

static void explicit_bzero(void *value, size_t length) {
  volatile unsigned char *bytes = (volatile unsigned char *)value;
  while (length > 0) {
    *bytes++ = 0;
    length--;
  }
}

static const char *const selector_names[] = {
  "HOME",
  "USERPROFILE",
  "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_ENV",
  "BIGMODEL_API_BASE_URL",
  "BIGMODEL_PRODUCTION_API_BASE_URL",
  "BIGMODEL_TEST_API_BASE_URL",
  "BIGMODEL_OAUTH_USERINFO_URL",
  "ZCODE_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
};

enum { SELECTOR_COUNT = (int)(sizeof(selector_names) / sizeof(selector_names[0])) };

struct selected_value {
  const unsigned char *bytes;
  size_t length;
  bool seen;
};

struct parsed_context {
  struct selected_value selectors[SELECTOR_COUNT];
  bool secret_seen;
  bool secret_override;
};

struct json_buffer {
  char bytes[MAX_JSON_BYTES];
  size_t length;
  bool failed;
};

static int emit_error(const char *code) {
  (void)printf("{\"error\":\"%s\"}\n", code);
  return 1;
}

static bool append_bytes(struct json_buffer *out, const char *value, size_t length) {
  if (out->failed || length > sizeof(out->bytes) - out->length) {
    out->failed = true;
    return false;
  }
  memcpy(out->bytes + out->length, value, length);
  out->length += length;
  return true;
}

static bool append_text(struct json_buffer *out, const char *value) {
  return append_bytes(out, value, strlen(value));
}

#ifndef ZCODE_CONTEXT_TEST
static bool append_unsigned(struct json_buffer *out, uint64_t value) {
  char number[32];
  int length = snprintf(number, sizeof(number), "%llu", (unsigned long long)value);
  return length > 0 && (size_t)length < sizeof(number) && append_bytes(out, number, (size_t)length);
}
#endif

static bool valid_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first <= 0x7f) continue;
    unsigned int continuation = 0;
    uint32_t codepoint = 0;
    uint32_t minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      continuation = 1;
      codepoint = first & 0x1fU;
      minimum = 0x80U;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuation = 2;
      codepoint = first & 0x0fU;
      minimum = 0x800U;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuation = 3;
      codepoint = first & 0x07U;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (continuation > length - index) return false;
    for (unsigned int offset = 0; offset < continuation; offset++) {
      unsigned char next = bytes[index++];
      if ((next & 0xc0U) != 0x80U) return false;
      codepoint = (codepoint << 6U) | (next & 0x3fU);
    }
    if (codepoint < minimum || codepoint > 0x10ffffU || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) return false;
  }
  return true;
}

static bool append_json_string(struct json_buffer *out, const unsigned char *value, size_t length) {
  static const char hex[] = "0123456789abcdef";
  if (!valid_utf8(value, length) || !append_text(out, "\"")) return false;
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = value[index];
    if (byte == '"' || byte == '\\') {
      char escaped[2] = {'\\', (char)byte};
      if (!append_bytes(out, escaped, sizeof(escaped))) return false;
    } else if (byte < 0x20U) {
      char escaped[6] = {'\\', 'u', '0', '0', hex[byte >> 4U], hex[byte & 0x0fU]};
      if (!append_bytes(out, escaped, sizeof(escaped))) return false;
    } else if (!append_bytes(out, (const char *)&value[index], 1)) {
      return false;
    }
  }
  return append_text(out, "\"");
}

static bool next_cstring(const unsigned char **cursor, const unsigned char *end,
                         const unsigned char **start, size_t *length) {
  if (*cursor >= end) return false;
  const unsigned char *nul = memchr(*cursor, '\0', (size_t)(end - *cursor));
  if (nul == NULL) return false;
  *start = *cursor;
  *length = (size_t)(nul - *cursor);
  *cursor = nul + 1;
  return true;
}

static int selector_index(const unsigned char *key, size_t length) {
  for (int index = 0; index < SELECTOR_COUNT; index++) {
    size_t expected = strlen(selector_names[index]);
    if (length == expected && memcmp(key, selector_names[index], length) == 0) return index;
  }
  return -1;
}

static bool key_equals(const unsigned char *key, size_t length, const char *expected) {
  size_t expected_length = strlen(expected);
  return length == expected_length && memcmp(key, expected, length) == 0;
}

static const char *parse_procargs(const unsigned char *buffer, size_t length,
                                  struct parsed_context *parsed) {
  if (buffer == NULL || parsed == NULL || length < sizeof(int)) return "format";
  memset(parsed, 0, sizeof(*parsed));
  int argument_count = 0;
  memcpy(&argument_count, buffer, sizeof(argument_count));
  if (argument_count < 1 || argument_count > 4096) return "format";

  const unsigned char *cursor = buffer + sizeof(argument_count);
  const unsigned char *end = buffer + length;
  const unsigned char *field = NULL;
  size_t field_length = 0;
  if (!next_cstring(&cursor, end, &field, &field_length) || field_length == 0) return "format";
  while (cursor < end && *cursor == '\0') cursor++;

  for (int index = 0; index < argument_count; index++) {
    if (!next_cstring(&cursor, end, &field, &field_length)) return "format";
    if (index == 0 && field_length == 0) return "format";
  }

  while (cursor < end) {
    /* Darwin separates envp from trailing apple strings with an empty entry. */
    if (*cursor == '\0') break;
    if (!next_cstring(&cursor, end, &field, &field_length) || field_length == 0) return "format";
    const unsigned char *equals = memchr(field, '=', field_length);
    if (equals == NULL || equals == field) return "format";
    size_t key_length = (size_t)(equals - field);
    const unsigned char *value = equals + 1;
    size_t value_length = field_length - key_length - 1;
    if (value_length > MAX_VALUE_BYTES) return "value";
    int selected = selector_index(field, key_length);
    bool is_secret = key_equals(field, key_length, "ZCODE_CREDENTIAL_SECRET");
    if (selected < 0 && !is_secret) continue;
    if (selected >= 0) {
      if (parsed->selectors[selected].seen) return "duplicate";
      if (!valid_utf8(value, value_length)) return "format";
      parsed->selectors[selected].bytes = value;
      parsed->selectors[selected].length = value_length;
      parsed->selectors[selected].seen = true;
    } else {
      if (parsed->secret_seen) return "duplicate";
      parsed->secret_seen = true;
      parsed->secret_override = value_length > 0;
    }
  }
  return NULL;
}

static bool append_selectors(struct json_buffer *out, const struct parsed_context *parsed) {
  if (!append_text(out, "\"selectors\":{")) return false;
  bool first = true;
  for (int index = 0; index < SELECTOR_COUNT; index++) {
    if (!parsed->selectors[index].seen) continue;
    if (!first && !append_text(out, ",")) return false;
    first = false;
    if (!append_json_string(out, (const unsigned char *)selector_names[index], strlen(selector_names[index]))
        || !append_text(out, ":")
        || !append_json_string(out, parsed->selectors[index].bytes, parsed->selectors[index].length)) return false;
  }
  return append_text(out, "},\"secretOverride\":")
    && append_text(out, parsed->secret_override ? "true" : "false");
}

static int write_json(struct json_buffer *out) {
  if (out->failed || !append_text(out, "}\n") || out->length > MAX_JSON_BYTES) return emit_error("output");
  if (fwrite(out->bytes, 1, out->length, stdout) != out->length) return 1;
  return 0;
}

#ifdef ZCODE_CONTEXT_TEST

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return emit_error("args");
  unsigned char *buffer = malloc(MAX_PROCARGS_BYTES + 1U);
  if (buffer == NULL) return emit_error("system");
  size_t length = fread(buffer, 1, MAX_PROCARGS_BYTES + 1U, stdin);
  if (ferror(stdin)) {
    explicit_bzero(buffer, MAX_PROCARGS_BYTES + 1U);
    free(buffer);
    return emit_error("system");
  }
  if (length > MAX_PROCARGS_BYTES) {
    explicit_bzero(buffer, MAX_PROCARGS_BYTES + 1U);
    free(buffer);
    return emit_error("size");
  }
  struct parsed_context parsed;
  const char *error = parse_procargs(buffer, length, &parsed);
  if (error != NULL) {
    explicit_bzero(buffer, MAX_PROCARGS_BYTES + 1U);
    free(buffer);
    return emit_error(error);
  }
  struct json_buffer output = {0};
  (void)append_text(&output, "{");
  (void)append_selectors(&output, &parsed);
  int status = write_json(&output);
  explicit_bzero(buffer, MAX_PROCARGS_BYTES + 1U);
  free(buffer);
  return status;
}

#else

static bool same_process(const struct proc_bsdinfo *left, const struct proc_bsdinfo *right) {
  return left->pbi_pid == right->pbi_pid && left->pbi_ppid == right->pbi_ppid
    && left->pbi_uid == right->pbi_uid && left->pbi_start_tvsec == right->pbi_start_tvsec
    && left->pbi_start_tvusec == right->pbi_start_tvusec;
}

static bool read_bsdinfo(int pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof(*info)) == (int)sizeof(*info);
}

static int parse_pid(const char *value, int *pid) {
  if (value == NULL || *value == '\0') return 0;
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed < 1 || parsed > INT_MAX) return 0;
  *pid = (int)parsed;
  return 1;
}

int main(int argc, char **argv) {
  int pid = 0;
  if (argc != 2 || !parse_pid(argv[1], &pid)) return emit_error("args");

  struct proc_bsdinfo before;
  if (!read_bsdinfo(pid, &before)) return emit_error("process");
  if (before.pbi_uid != getuid()) return emit_error("permissions");

  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
  int executable_length = proc_pidpath(pid, executable, (uint32_t)sizeof(executable));
  if (executable_length <= 0 || (size_t)executable_length >= sizeof(executable)) return emit_error("process");
  size_t executable_bytes = strnlen(executable, sizeof(executable));
  if (executable_bytes == 0 || executable_bytes >= sizeof(executable) || !valid_utf8((const unsigned char *)executable, executable_bytes)) {
    return emit_error("format");
  }

  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) return emit_error("process");
  if (size < sizeof(int) || size > MAX_PROCARGS_BYTES) return emit_error("size");
  unsigned char *buffer = malloc(size);
  if (buffer == NULL) return emit_error("system");
  size_t actual = size;
  if (sysctl(mib, 3, buffer, &actual, NULL, 0) != 0 || actual < sizeof(int) || actual > size) {
    explicit_bzero(buffer, size);
    free(buffer);
    return emit_error("process");
  }

  struct parsed_context parsed;
  const char *parse_error = parse_procargs(buffer, actual, &parsed);
  if (parse_error != NULL) {
    explicit_bzero(buffer, size);
    free(buffer);
    return emit_error(parse_error);
  }

  struct proc_bsdinfo after;
  if (!read_bsdinfo(pid, &after) || !same_process(&before, &after)) {
    explicit_bzero(buffer, size);
    free(buffer);
    return emit_error("changed");
  }

  struct json_buffer output = {0};
  (void)append_text(&output, "{\"pid\":");
  (void)append_unsigned(&output, (uint64_t)before.pbi_pid);
  (void)append_text(&output, ",\"uid\":");
  (void)append_unsigned(&output, (uint64_t)before.pbi_uid);
  (void)append_text(&output, ",\"ppid\":");
  (void)append_unsigned(&output, (uint64_t)before.pbi_ppid);
  (void)append_text(&output, ",\"startSeconds\":");
  (void)append_unsigned(&output, before.pbi_start_tvsec);
  (void)append_text(&output, ",\"startMicros\":");
  (void)append_unsigned(&output, before.pbi_start_tvusec);
  (void)append_text(&output, ",\"executable\":");
  (void)append_json_string(&output, (const unsigned char *)executable, executable_bytes);
  (void)append_text(&output, ",");
  (void)append_selectors(&output, &parsed);
  int status = write_json(&output);
  explicit_bzero(buffer, size);
  free(buffer);
  explicit_bzero(executable, sizeof(executable));
  return status;
}

#endif
