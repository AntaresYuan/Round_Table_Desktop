#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>

enum {
  RT_PROBE_BUFFER_BYTES = 1024 * 1024,
  RT_PROBE_DENIED = 7,
  RT_PROBE_FAILED = 8,
  RT_PROBE_MARKER_MISSING = 9,
};

static int rt_buffer_contains(
    const unsigned char *buffer,
    size_t buffer_size,
    const unsigned char *needle,
    size_t needle_size) {
  size_t offset;

  if (needle_size == 0 || needle_size > buffer_size) {
    return 0;
  }
  for (offset = 0; offset <= buffer_size - needle_size; offset += 1) {
    if (memcmp(buffer + offset, needle, needle_size) == 0) {
      return 1;
    }
  }
  return 0;
}

static int rt_parse_pid(const char *text, pid_t *pid_out) {
  char *end = NULL;
  long value;

  if (text == NULL || text[0] == '\0') {
    return 0;
  }
  errno = 0;
  value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT_MAX) {
    return 0;
  }
  *pid_out = (pid_t)value;
  return 1;
}

static int rt_probe_procargs(pid_t pid, const char *marker) {
  unsigned char *buffer;
  size_t buffer_size = RT_PROBE_BUFFER_BYTES;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};

  buffer = calloc(1, RT_PROBE_BUFFER_BYTES);
  if (buffer == NULL) {
    return RT_PROBE_FAILED;
  }
  if (sysctl(mib, 3, buffer, &buffer_size, NULL, 0) != 0) {
    int saved_errno = errno;
    free(buffer);
    /* macOS reports EINVAL, rather than EPERM, for some cross-UID targets. */
    if (saved_errno == EPERM || saved_errno == EACCES || saved_errno == EINVAL) {
      (void)fputs("denied\n", stdout);
      return RT_PROBE_DENIED;
    }
    return RT_PROBE_FAILED;
  }
  if (!rt_buffer_contains(
          buffer,
          buffer_size,
          (const unsigned char *)marker,
          strlen(marker))) {
    free(buffer);
    return RT_PROBE_MARKER_MISSING;
  }
  free(buffer);
  (void)fputs("allowed\n", stdout);
  return 0;
}

int main(int argc, char *argv[]) {
  pid_t pid;

  if (argc != 4 || strcmp(argv[1], "procargs") != 0 || !rt_parse_pid(argv[2], &pid) ||
      argv[3][0] == '\0' || strlen(argv[3]) > 256) {
    return RT_PROBE_FAILED;
  }
  return rt_probe_procargs(pid, argv[3]);
}
