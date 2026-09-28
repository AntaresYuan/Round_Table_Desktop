#define _DARWIN_C_SOURCE 1

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/*
 * Roundtable's macOS process helper deliberately uses two private, runtime-
 * discovered coalition query functions.  There is no public, unprivileged
 * API which can terminate a resource coalition.  Consequently this helper
 * enumerates a launchd job's immutable resource coalition, signals each
 * execution through an audit token, and only reports success after a strong
 * coalition-level reconciliation.
 *
 * Missing or changed private ABI is a hard failure.  Do not replace these
 * checks with a best-effort process-tree walk: that would reintroduce the
 * fork/setsid/reparent race this helper exists to close.
 */

#define RT_PROC_PIDUNIQIDENTIFIERINFO 17
#define RT_PROC_PIDCOALITIONINFO 20
#define RT_COALITION_MAX_PIDS 512U
#define RT_POLL_INTERVAL_MS 20U
#define RT_INTERNAL_GRACE_MS 750U
#define RT_INTERNAL_CONFIRM_MS 5000U
#define RT_CONNECT_TIMEOUT_MS 10000U
#define RT_MAX_ENV_BYTES (4U * 1024U * 1024U)
#define RT_MAX_STDIN_BYTES (64U * 1024U * 1024U)
#define RT_OUTPUT_BUFFER_BYTES (64U * 1024U)
#define RT_CONFIG_MAGIC "RTCFG001"
#define RT_CONFIG_MAGIC_BYTES 8U
#define RT_NONCE_BYTES 64U
#define RT_NONCE_BUFFER_BYTES (RT_NONCE_BYTES + 1U)

typedef int (*rt_coalition_pid_list_fn)(uint64_t, pid_t *, size_t *);
typedef int (*rt_coalition_resource_usage_fn)(uint64_t, void *, size_t);
typedef int (*rt_proc_signal_with_audittoken_fn)(audit_token_t *, int);

struct rt_proc_uniqidentifierinfo {
  uint8_t uuid[16];
  uint64_t uniqueid;
  uint64_t parent_uniqueid;
  int32_t pidversion;
  int32_t parent_pidversion;
  uint64_t reserved2;
  uint64_t reserved3;
};

struct rt_proc_coalitioninfo {
  uint64_t coalition_id[2];
  uint64_t reserved1;
  uint64_t reserved2;
  uint64_t reserved3;
};

struct rt_resource_usage_prefix {
  uint64_t tasks_started;
  uint64_t tasks_exited;
};

_Static_assert(sizeof(struct rt_proc_uniqidentifierinfo) == 56,
               "unexpected unique-identifier ABI layout");
_Static_assert(sizeof(struct rt_proc_coalitioninfo) == 40,
               "unexpected coalition ABI layout");
_Static_assert(sizeof(struct rt_resource_usage_prefix) == 16,
               "unexpected resource-usage prefix layout");
_Static_assert(sizeof(audit_token_t) == sizeof(uint32_t) * 8U,
               "unexpected audit token layout");

struct rt_identity {
  pid_t pid;
  uint32_t pidversion;
  uint64_t uniqueid;
  uint64_t resource_cid;
  uint32_t status;
};

struct rt_snapshot {
  struct rt_identity members[RT_COALITION_MAX_PIDS];
  size_t count;
  uint64_t active_count;
  bool complete;
};

enum rt_query_result {
  RT_QUERY_OK = 0,
  RT_QUERY_GONE = 1,
  RT_QUERY_ERROR = 2,
};

enum rt_signal_result {
  RT_SIGNAL_SENT = 0,
  RT_SIGNAL_STALE = 1,
  RT_SIGNAL_ERROR = 2,
};

enum rt_cleanup_result {
  RT_CLEANUP_CONFIRMED = 0,
  RT_CLEANUP_FAILED = 1,
};

static rt_coalition_pid_list_fn rt_coalition_pid_list = NULL;
static rt_coalition_resource_usage_fn rt_coalition_resource_usage = NULL;
static rt_proc_signal_with_audittoken_fn rt_proc_signal_with_audittoken = NULL;
static volatile sig_atomic_t rt_owner_signal = 0;
static bool rt_trace_enabled = false;

static void rt_trace(const char *format, ...) {
  va_list arguments;

  if (!rt_trace_enabled) {
    return;
  }
  va_start(arguments, format);
  (void)fprintf(stderr, "roundtable-macos-process-helper: ");
  (void)vfprintf(stderr, format, arguments);
  (void)fputc('\n', stderr);
  va_end(arguments);
}

static uint64_t rt_monotonic_ms(void) {
  struct timespec value;

  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
    return 0;
  }
  return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}

static void rt_sleep_ms(uint32_t milliseconds) {
  struct timespec requested;
  struct timespec remaining;

  requested.tv_sec = (time_t)(milliseconds / 1000U);
  requested.tv_nsec = (long)(milliseconds % 1000U) * 1000000L;
  while (nanosleep(&requested, &remaining) != 0 && errno == EINTR) {
    requested = remaining;
  }
}

static void rt_signal_handler(int signal_number) {
  rt_owner_signal = signal_number;
}

static bool rt_install_signal_handlers(void) {
  struct sigaction action;

  memset(&action, 0, sizeof(action));
  action.sa_handler = rt_signal_handler;
  (void)sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0) {
    return false;
  }

  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_IGN;
  (void)sigemptyset(&action.sa_mask);
  return sigaction(SIGPIPE, &action, NULL) == 0;
}

static bool rt_parse_u64(const char *text, uint64_t *value_out) {
  char *end = NULL;
  unsigned long long value;
  const unsigned char *cursor;

  if (text == NULL || text[0] == '\0') {
    return false;
  }
  for (cursor = (const unsigned char *)text; *cursor != '\0'; cursor++) {
    if (*cursor < (unsigned char)'0' || *cursor > (unsigned char)'9') {
      return false;
    }
  }
  errno = 0;
  value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') {
    return false;
  }
  *value_out = (uint64_t)value;
  return true;
}

static bool rt_parse_pid(const char *text, pid_t *pid_out) {
  uint64_t value;

  if (!rt_parse_u64(text, &value) || value == 0 || value > INT_MAX) {
    return false;
  }
  *pid_out = (pid_t)value;
  return true;
}

static bool rt_parse_ms(const char *text, uint32_t *value_out) {
  uint64_t value;

  if (!rt_parse_u64(text, &value) || value > UINT32_MAX) {
    return false;
  }
  *value_out = (uint32_t)value;
  return true;
}

static bool rt_valid_nonce(const char *nonce) {
  size_t index;

  if (nonce == NULL || strlen(nonce) != 64U) {
    return false;
  }
  for (index = 0; index < 64U; index++) {
    char value = nonce[index];
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') ||
          (value >= 'A' && value <= 'F'))) {
      return false;
    }
  }
  return true;
}

static void rt_secure_zero(void *buffer, size_t length) {
  volatile uint8_t *bytes = (volatile uint8_t *)buffer;

  while (length > 0) {
    *bytes++ = 0;
    length--;
  }
}

static bool rt_nonce_file_info_valid(const struct stat *info) {
  return S_ISREG(info->st_mode) && info->st_uid == geteuid() &&
         (info->st_mode & 07777) == 0400 && info->st_nlink == 1 &&
         info->st_size == (off_t)RT_NONCE_BYTES;
}

static bool rt_nonce_file_info_equal(const struct stat *left,
                                     const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_uid == right->st_uid && left->st_mode == right->st_mode &&
         left->st_nlink == right->st_nlink && left->st_size == right->st_size &&
         left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
         left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
         left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
         left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static bool rt_read_nonce_secret_file(
    const char *path, char nonce_out[RT_NONCE_BUFFER_BYTES]) {
  int fd = -1;
  struct stat before;
  struct stat after;
  struct stat linked;
  size_t offset = 0;
  uint8_t extra;
  ssize_t count;
  bool succeeded = false;
  const unsigned char *cursor;

  rt_secure_zero(nonce_out, RT_NONCE_BUFFER_BYTES);
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX) {
    return false;
  }
  for (cursor = (const unsigned char *)path; *cursor != '\0'; cursor++) {
    if (*cursor < 0x20U || *cursor == 0x7fU) {
      return false;
    }
  }
  fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &before) != 0 ||
      !rt_nonce_file_info_valid(&before)) {
    goto finished;
  }
  while (offset < RT_NONCE_BYTES) {
    count = read(fd, nonce_out + offset, RT_NONCE_BYTES - offset);
    if (count > 0) {
      offset += (size_t)count;
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      goto finished;
    }
  }
  do {
    count = read(fd, &extra, sizeof(extra));
  } while (count < 0 && errno == EINTR);
  if (count != 0 || fstat(fd, &after) != 0 ||
      !rt_nonce_file_info_valid(&after) ||
      !rt_nonce_file_info_equal(&before, &after)) {
    goto finished;
  }
  nonce_out[RT_NONCE_BYTES] = '\0';
  if (!rt_valid_nonce(nonce_out) || lstat(path, &linked) != 0 ||
      !rt_nonce_file_info_valid(&linked) ||
      !rt_nonce_file_info_equal(&before, &linked) || unlink(path) != 0) {
    goto finished;
  }
  succeeded = true;

finished:
  if (fd >= 0) {
    (void)close(fd);
  }
  if (!succeeded) {
    rt_secure_zero(nonce_out, RT_NONCE_BUFFER_BYTES);
  }
  return succeeded;
}

static enum rt_query_result rt_read_identity(pid_t pid,
                                             struct rt_identity *identity) {
  struct rt_proc_uniqidentifierinfo first;
  struct rt_proc_uniqidentifierinfo second;
  struct rt_proc_coalitioninfo coalition;
  struct proc_bsdshortinfo bsd;
  int result;

  memset(&first, 0, sizeof(first));
  errno = 0;
  result = proc_pidinfo(pid, RT_PROC_PIDUNIQIDENTIFIERINFO, 0, &first,
                        (int)sizeof(first));
  if (result != (int)sizeof(first)) {
    return (result == 0 || errno == ESRCH) ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }

  memset(&coalition, 0, sizeof(coalition));
  errno = 0;
  result = proc_pidinfo(pid, RT_PROC_PIDCOALITIONINFO, 0, &coalition,
                        (int)sizeof(coalition));
  if (result != (int)sizeof(coalition)) {
    return (result == 0 || errno == ESRCH) ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }

  memset(&bsd, 0, sizeof(bsd));
  errno = 0;
  result = proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &bsd, (int)sizeof(bsd));
  if (result != (int)sizeof(bsd)) {
    return (result == 0 || errno == ESRCH) ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }

  memset(&second, 0, sizeof(second));
  errno = 0;
  result = proc_pidinfo(pid, RT_PROC_PIDUNIQIDENTIFIERINFO, 0, &second,
                        (int)sizeof(second));
  if (result != (int)sizeof(second)) {
    return (result == 0 || errno == ESRCH) ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }

  if (first.uniqueid == 0 || first.uniqueid != second.uniqueid ||
      first.pidversion != second.pidversion || bsd.pbsi_pid != (uint32_t)pid ||
      coalition.coalition_id[0] == 0) {
    return RT_QUERY_ERROR;
  }

  identity->pid = pid;
  identity->pidversion = (uint32_t)first.pidversion;
  identity->uniqueid = first.uniqueid;
  identity->resource_cid = coalition.coalition_id[0];
  identity->status = bsd.pbsi_status;
  return RT_QUERY_OK;
}

static enum rt_query_result rt_query_active_count(uint64_t cid,
                                                  uint64_t *active_out) {
  struct rt_resource_usage_prefix usage;
  int result;

  memset(&usage, 0, sizeof(usage));
  errno = 0;
  result = rt_coalition_resource_usage(cid, &usage, sizeof(usage));
  if (result != 0) {
    return errno == ESRCH ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }
  if (usage.tasks_exited > usage.tasks_started) {
    return RT_QUERY_ERROR;
  }
  *active_out = usage.tasks_started - usage.tasks_exited;
  return RT_QUERY_OK;
}

static enum rt_query_result rt_query_pid_list(uint64_t cid, pid_t *pids,
                                              size_t *count_out,
                                              bool *saturated_out) {
  size_t size = RT_COALITION_MAX_PIDS * sizeof(pid_t);
  int result;

  memset(pids, 0, RT_COALITION_MAX_PIDS * sizeof(pid_t));
  errno = 0;
  result = rt_coalition_pid_list(cid, pids, &size);
  if (result != 0) {
    return errno == ESRCH ? RT_QUERY_GONE : RT_QUERY_ERROR;
  }
  if (size > RT_COALITION_MAX_PIDS * sizeof(pid_t) ||
      size % sizeof(pid_t) != 0) {
    return RT_QUERY_ERROR;
  }
  *count_out = size / sizeof(pid_t);
  *saturated_out = *count_out == RT_COALITION_MAX_PIDS;
  return RT_QUERY_OK;
}

static bool rt_has_duplicate_pid(const pid_t *pids, size_t count) {
  size_t left;
  size_t right;

  for (left = 0; left < count; left++) {
    if (pids[left] <= 0) {
      return true;
    }
    for (right = left + 1U; right < count; right++) {
      if (pids[left] == pids[right]) {
        return true;
      }
    }
  }
  return false;
}

static enum rt_query_result rt_take_snapshot(uint64_t cid,
                                             struct rt_snapshot *snapshot) {
  pid_t pids[RT_COALITION_MAX_PIDS];
  uint64_t active_before = 0;
  uint64_t active_after = 0;
  size_t raw_count = 0;
  size_t index;
  bool saturated = false;
  bool unstable = false;
  enum rt_query_result result;

  memset(snapshot, 0, sizeof(*snapshot));
  result = rt_query_active_count(cid, &active_before);
  if (result != RT_QUERY_OK) {
    return result;
  }
  result = rt_query_pid_list(cid, pids, &raw_count, &saturated);
  if (result != RT_QUERY_OK) {
    return result;
  }
  if (rt_has_duplicate_pid(pids, raw_count)) {
    unstable = true;
  }

  for (index = 0; index < raw_count; index++) {
    struct rt_identity identity;
    enum rt_query_result identity_result =
        rt_read_identity(pids[index], &identity);

    if (identity_result != RT_QUERY_OK || identity.resource_cid != cid) {
      unstable = true;
      continue;
    }
    snapshot->members[snapshot->count++] = identity;
  }

  result = rt_query_active_count(cid, &active_after);
  if (result != RT_QUERY_OK) {
    return result;
  }
  snapshot->active_count = active_after;
  snapshot->complete =
      !saturated && !unstable && active_before == active_after &&
      active_after == raw_count && snapshot->count == raw_count;
  return RT_QUERY_OK;
}

static bool rt_identity_equal(const struct rt_identity *left,
                              const struct rt_identity *right) {
  return left->pid == right->pid && left->uniqueid == right->uniqueid &&
         left->resource_cid == right->resource_cid;
}

static enum rt_signal_result
rt_signal_execution(const struct rt_identity *expected, int signal_number) {
  struct rt_identity current;
  audit_token_t token;
  enum rt_query_result query;
  int result;
  int saved_errno;

  query = rt_read_identity(expected->pid, &current);
  if (query == RT_QUERY_GONE) {
    return RT_SIGNAL_STALE;
  }
  if (query != RT_QUERY_OK || current.uniqueid != expected->uniqueid ||
      current.resource_cid != expected->resource_cid) {
    return query == RT_QUERY_OK ? RT_SIGNAL_STALE : RT_SIGNAL_ERROR;
  }
  if (signal_number == SIGCONT && expected->status == SSTOP &&
      current.status != SSTOP) {
    return RT_SIGNAL_ERROR;
  }

  memset(&token, 0, sizeof(token));
  token.val[5] = (uint32_t)current.pid;
  token.val[7] = current.pidversion;
  errno = 0;
  result = rt_proc_signal_with_audittoken(&token, signal_number);
  saved_errno = errno;
  rt_trace("audit signal pid=%d uniqueid=%llu pidversion=%u signal=%d "
           "result=%d errno=%d",
           current.pid, (unsigned long long)current.uniqueid,
           current.pidversion, signal_number, result, saved_errno);
  if (result == 0) {
    return RT_SIGNAL_SENT;
  }
  if ((result == -1 && saved_errno == ESRCH) || result == ESRCH) {
    return RT_SIGNAL_STALE;
  }
  return RT_SIGNAL_ERROR;
}

static bool rt_is_excluded(const struct rt_identity *member,
                           const struct rt_identity *exclude) {
  return exclude != NULL && rt_identity_equal(member, exclude);
}

static bool rt_terminal_proof(uint64_t cid, const struct rt_identity *exclude,
                              bool *confirmed_out) {
  struct rt_snapshot snapshot;
  enum rt_query_result result;

  *confirmed_out = false;
  result = rt_take_snapshot(cid, &snapshot);
  if (result == RT_QUERY_GONE) {
    uint64_t unused_active = 0;
    pid_t unused_pids[RT_COALITION_MAX_PIDS];
    size_t unused_count = 0;
    bool unused_saturated = false;
    enum rt_query_result usage_result;
    enum rt_query_result list_result;

    usage_result = rt_query_active_count(cid, &unused_active);
    list_result =
        rt_query_pid_list(cid, unused_pids, &unused_count, &unused_saturated);
    if (usage_result == RT_QUERY_GONE && list_result == RT_QUERY_GONE &&
        exclude == NULL) {
      *confirmed_out = true;
      rt_trace("terminal proof cid=%llu: resource usage and pid list ESRCH",
               (unsigned long long)cid);
      return true;
    }
    return usage_result != RT_QUERY_ERROR && list_result != RT_QUERY_ERROR;
  }
  if (result != RT_QUERY_OK) {
    return false;
  }
  if (!snapshot.complete) {
    return true;
  }

  if (exclude == NULL) {
    /*
     * External termination is only called after launchd bootout.  Even an
     * empty, still-queryable coalition is not a terminal proof: only the
     * paired ESRCH result above proves the job coalition has ceased to exist.
     */
    *confirmed_out = false;
  } else {
    *confirmed_out = snapshot.count == 1 && snapshot.active_count == 1 &&
                     rt_identity_equal(&snapshot.members[0], exclude);
  }
  if (*confirmed_out) {
    rt_trace("terminal proof cid=%llu: active=%llu members=%zu exclude=%s",
             (unsigned long long)cid, (unsigned long long)snapshot.active_count,
             snapshot.count, exclude == NULL ? "none" : "self");
  }
  return true;
}

static void rt_signal_snapshot(const struct rt_snapshot *snapshot,
                               const struct rt_identity *exclude,
                               int signal_number) {
  size_t index;

  for (index = 0; index < snapshot->count; index++) {
    if (!rt_is_excluded(&snapshot->members[index], exclude)) {
      (void)rt_signal_execution(&snapshot->members[index], signal_number);
    }
  }
}

static bool rt_snapshot_is_frozen(const struct rt_snapshot *snapshot,
                                  const struct rt_identity *exclude) {
  size_t index;
  size_t excluded_count = 0;

  if (!snapshot->complete) {
    return false;
  }
  for (index = 0; index < snapshot->count; index++) {
    const struct rt_identity *member = &snapshot->members[index];
    if (rt_is_excluded(member, exclude)) {
      excluded_count++;
      continue;
    }
    if (member->status != SSTOP) {
      return false;
    }
  }
  return exclude == NULL ? excluded_count == 0 : excluded_count == 1;
}

static enum rt_cleanup_result
rt_cleanup_coalition(uint64_t cid, const struct rt_identity *exclude,
                     uint32_t grace_ms, uint32_t confirm_ms) {
  uint64_t now = rt_monotonic_ms();
  uint64_t grace_deadline = now + grace_ms;
  uint64_t final_deadline;
  struct rt_snapshot snapshot;
  bool confirmed = false;
  bool frozen = false;

  if (now == 0 || UINT64_MAX - now < grace_ms ||
      UINT64_MAX - (now + grace_ms) < confirm_ms) {
    return RT_CLEANUP_FAILED;
  }
  final_deadline = grace_deadline + confirm_ms;

  /* Cooperative termination phase. */
  do {
    enum rt_query_result result;

    if (!rt_terminal_proof(cid, exclude, &confirmed)) {
      return RT_CLEANUP_FAILED;
    }
    if (confirmed) {
      return RT_CLEANUP_CONFIRMED;
    }
    result = rt_take_snapshot(cid, &snapshot);
    if (result == RT_QUERY_OK) {
      rt_signal_snapshot(&snapshot, exclude, SIGTERM);
    } else if (result == RT_QUERY_ERROR) {
      return RT_CLEANUP_FAILED;
    }
    if (rt_monotonic_ms() >= grace_deadline) {
      break;
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  } while (true);

  /* Freeze to a complete, stable set.  A stopped set cannot fork again. */
  while (rt_monotonic_ms() < final_deadline) {
    enum rt_query_result result = rt_take_snapshot(cid, &snapshot);

    if (result == RT_QUERY_GONE) {
      if (rt_terminal_proof(cid, exclude, &confirmed) && confirmed) {
        return RT_CLEANUP_CONFIRMED;
      }
    } else if (result == RT_QUERY_ERROR) {
      return RT_CLEANUP_FAILED;
    } else {
      if (snapshot.complete &&
          ((exclude == NULL && snapshot.count == 0) ||
           (exclude != NULL && snapshot.count == 1 &&
            rt_identity_equal(&snapshot.members[0], exclude)))) {
        if (rt_terminal_proof(cid, exclude, &confirmed) && confirmed) {
          return RT_CLEANUP_CONFIRMED;
        }
      }
      rt_signal_snapshot(&snapshot, exclude, SIGSTOP);
      rt_sleep_ms(RT_POLL_INTERVAL_MS);
      result = rt_take_snapshot(cid, &snapshot);
      if (result == RT_QUERY_OK && rt_snapshot_is_frozen(&snapshot, exclude)) {
        frozen = true;
        break;
      }
      if (result == RT_QUERY_ERROR) {
        return RT_CLEANUP_FAILED;
      }
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }

  if (!frozen) {
    return RT_CLEANUP_FAILED;
  }

  /* Kill the reconciled frozen set, then keep killing any observed residue. */
  rt_signal_snapshot(&snapshot, exclude, SIGKILL);
  while (rt_monotonic_ms() < final_deadline) {
    enum rt_query_result result;

    if (!rt_terminal_proof(cid, exclude, &confirmed)) {
      return RT_CLEANUP_FAILED;
    }
    if (confirmed) {
      return RT_CLEANUP_CONFIRMED;
    }
    result = rt_take_snapshot(cid, &snapshot);
    if (result == RT_QUERY_OK) {
      rt_signal_snapshot(&snapshot, exclude, SIGKILL);
    } else if (result == RT_QUERY_ERROR) {
      return RT_CLEANUP_FAILED;
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }

  return RT_CLEANUP_FAILED;
}

static bool rt_load_and_probe_abi(struct rt_identity *self_out) {
  void *pid_list_symbol;
  void *usage_symbol;
  void *signal_symbol;
  struct rt_identity self;
  struct rt_snapshot snapshot;
  bool stable_snapshot = false;
  uint64_t probe_start;
  audit_token_t token;
  int signal_result;

  pid_list_symbol = dlsym(RTLD_DEFAULT, "coalition_info_pid_list");
  usage_symbol = dlsym(RTLD_DEFAULT, "coalition_info_resource_usage");
  signal_symbol = dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  if (pid_list_symbol == NULL || usage_symbol == NULL ||
      signal_symbol == NULL) {
    return false;
  }
  memcpy(&rt_coalition_pid_list, &pid_list_symbol,
         sizeof(rt_coalition_pid_list));
  memcpy(&rt_coalition_resource_usage, &usage_symbol,
         sizeof(rt_coalition_resource_usage));
  memcpy(&rt_proc_signal_with_audittoken, &signal_symbol,
         sizeof(rt_proc_signal_with_audittoken));

  if (rt_read_identity(getpid(), &self) != RT_QUERY_OK ||
      self.pid != getpid()) {
    return false;
  }
  probe_start = rt_monotonic_ms();
  while (probe_start != 0 && rt_monotonic_ms() - probe_start < 1000U) {
    size_t index;

    if (rt_take_snapshot(self.resource_cid, &snapshot) == RT_QUERY_OK &&
        snapshot.complete) {
      for (index = 0; index < snapshot.count; index++) {
        if (rt_identity_equal(&snapshot.members[index], &self)) {
          stable_snapshot = true;
          break;
        }
      }
    }
    if (stable_snapshot) {
      break;
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }
  if (!stable_snapshot || snapshot.active_count == 0) {
    return false;
  }

  /*
   * proc_signal_with_audittoken returns an errno value directly and rejects
   * signal 0 with EINVAL on current macOS.  SIGCONT is harmless for this
   * running helper and exercises the real token-validated signal path.
   */
  memset(&token, 0, sizeof(token));
  token.val[5] = (uint32_t)self.pid;
  token.val[7] = self.pidversion;
  errno = 0;
  signal_result = rt_proc_signal_with_audittoken(&token, SIGCONT);
  rt_trace("audit signal startup probe pid=%d pidversion=%u result=%d errno=%d",
           self.pid, self.pidversion, signal_result, errno);
  if (signal_result != 0) {
    return false;
  }

  *self_out = self;
  return true;
}

struct rt_run_config {
  uint8_t *environment_block;
  size_t environment_length;
  char **environment;
  uint8_t *stdin_bytes;
  size_t stdin_length;
};

struct rt_output_channel {
  int pipe_fd;
  int socket_fd;
  uint8_t pending[RT_OUTPUT_BUFFER_BYTES];
  size_t offset;
  size_t length;
  bool pipe_eof;
};

struct rt_run_io {
  int control_fd;
  int stdin_fd;
  const uint8_t *stdin_bytes;
  size_t stdin_length;
  size_t stdin_offset;
  struct rt_output_channel stdout_channel;
  struct rt_output_channel stderr_channel;
};

static void rt_close_fd(int *fd) {
  if (*fd >= 0) {
    (void)close(*fd);
    *fd = -1;
  }
}

static bool rt_set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);

  return flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

static bool rt_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);

  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int rt_connect_unix_socket(const char *path) {
  struct sockaddr_un address;
  uint64_t start = rt_monotonic_ms();

  if (path == NULL || path[0] == '\0' ||
      strlen(path) >= sizeof(address.sun_path) || start == 0) {
    errno = EINVAL;
    return -1;
  }

  while (!rt_owner_signal &&
         rt_monotonic_ms() - start < RT_CONNECT_TIMEOUT_MS) {
    int fd;
    int no_sigpipe = 1;

    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      return -1;
    }
    if (!rt_set_cloexec(fd) ||
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                   (socklen_t)sizeof(no_sigpipe)) != 0) {
      (void)close(fd);
      return -1;
    }

    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    address.sun_len = (uint8_t)sizeof(address);
    memcpy(address.sun_path, path, strlen(path) + 1U);
    if (connect(fd, (struct sockaddr *)&address, (socklen_t)sizeof(address)) ==
        0) {
      uid_t peer_euid;
      gid_t peer_egid;

      if (getpeereid(fd, &peer_euid, &peer_egid) != 0 ||
          peer_euid != geteuid()) {
        (void)close(fd);
        errno = EPERM;
        return -1;
      }
      (void)peer_egid;
      if (!rt_set_nonblocking(fd)) {
        (void)close(fd);
        return -1;
      }
      return fd;
    }
    (void)close(fd);
    if (errno != ENOENT && errno != ECONNREFUSED) {
      return -1;
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }
  errno = rt_owner_signal ? EINTR : ETIMEDOUT;
  return -1;
}

static bool rt_send_all(int fd, const void *buffer, size_t length,
                        uint32_t timeout_ms) {
  const uint8_t *bytes = buffer;
  size_t offset = 0;
  uint64_t start = rt_monotonic_ms();

  if (start == 0) {
    return false;
  }
  while (offset < length && !rt_owner_signal) {
    ssize_t result = send(fd, bytes + offset, length - offset, 0);

    if (result > 0) {
      offset += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd descriptor;
      int poll_result;

      if (rt_monotonic_ms() - start >= timeout_ms) {
        return false;
      }
      descriptor.fd = fd;
      descriptor.events = POLLOUT;
      descriptor.revents = 0;
      poll_result = poll(&descriptor, 1, (int)RT_POLL_INTERVAL_MS);
      if (poll_result < 0 && errno != EINTR) {
        return false;
      }
      if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return offset == length;
}

static bool rt_send_formatted_line(int fd, const char *format, ...) {
  char line[256];
  va_list arguments;
  int length;

  va_start(arguments, format);
  length = vsnprintf(line, sizeof(line), format, arguments);
  va_end(arguments);
  if (length < 0 || (size_t)length >= sizeof(line)) {
    return false;
  }
  return rt_send_all(fd, line, (size_t)length, 5000U);
}

static bool rt_output_peer_alive(int fd) {
  struct pollfd descriptor;
  int result;

  descriptor.fd = fd;
  descriptor.events = POLLIN;
  descriptor.revents = 0;
  result = poll(&descriptor, 1, 0);
  if (result < 0) {
    return errno == EINTR;
  }
  if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL | POLLIN)) {
    return false;
  }
  return true;
}

static bool rt_receive_exact(int control_fd, int stdout_fd, int stderr_fd,
                             void *buffer, size_t length) {
  uint8_t *bytes = buffer;
  size_t offset = 0;

  while (offset < length && !rt_owner_signal) {
    struct pollfd descriptors[3];
    int result;

    descriptors[0].fd = control_fd;
    descriptors[0].events = POLLIN;
    descriptors[0].revents = 0;
    descriptors[1].fd = stdout_fd;
    descriptors[1].events = POLLIN;
    descriptors[1].revents = 0;
    descriptors[2].fd = stderr_fd;
    descriptors[2].events = POLLIN;
    descriptors[2].revents = 0;
    result = poll(descriptors, 3, 250);
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    if (descriptors[1].revents != 0 || descriptors[2].revents != 0) {
      return false;
    }
    if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
      return false;
    }
    if (descriptors[0].revents & POLLIN) {
      ssize_t received = recv(control_fd, bytes + offset, length - offset, 0);

      if (received > 0) {
        offset += (size_t)received;
      } else if (received == 0) {
        return false;
      } else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
        return false;
      }
    }
  }
  return offset == length;
}

static void rt_free_config(struct rt_run_config *config) {
  free(config->environment);
  free(config->environment_block);
  free(config->stdin_bytes);
  memset(config, 0, sizeof(*config));
}

static bool rt_parse_environment(struct rt_run_config *config) {
  size_t index = 0;
  size_t entries = 0;
  size_t output_index = 0;

  if (config->environment_length == 0) {
    config->environment = calloc(1, sizeof(char *));
    return config->environment != NULL;
  }
  if (config->environment_block[config->environment_length - 1U] != '\0') {
    return false;
  }
  while (index < config->environment_length) {
    size_t start = index;
    bool found_equals = false;

    while (index < config->environment_length &&
           config->environment_block[index] != '\0') {
      if (config->environment_block[index] == '=' && index > start) {
        found_equals = true;
      }
      index++;
    }
    if (index == start || index >= config->environment_length ||
        !found_equals) {
      return false;
    }
    entries++;
    index++;
  }
  if (entries > SIZE_MAX / sizeof(char *) - 1U) {
    return false;
  }
  config->environment = calloc(entries + 1U, sizeof(char *));
  if (config->environment == NULL) {
    return false;
  }
  index = 0;
  while (index < config->environment_length) {
    config->environment[output_index++] =
        (char *)&config->environment_block[index];
    index += strlen((char *)&config->environment_block[index]) + 1U;
  }
  return true;
}

static bool rt_receive_config(int control_fd, int stdout_fd, int stderr_fd,
                              struct rt_run_config *config) {
  uint8_t header[RT_CONFIG_MAGIC_BYTES + 8U];
  uint32_t environment_be;
  uint32_t stdin_be;
  uint32_t environment_length;
  uint32_t stdin_length;

  memset(config, 0, sizeof(*config));
  if (!rt_receive_exact(control_fd, stdout_fd, stderr_fd, header,
                        sizeof(header)) ||
      memcmp(header, RT_CONFIG_MAGIC, RT_CONFIG_MAGIC_BYTES) != 0) {
    return false;
  }
  memcpy(&environment_be, header + RT_CONFIG_MAGIC_BYTES,
         sizeof(environment_be));
  memcpy(&stdin_be, header + RT_CONFIG_MAGIC_BYTES + sizeof(environment_be),
         sizeof(stdin_be));
  environment_length = ntohl(environment_be);
  stdin_length = ntohl(stdin_be);
  if (environment_length > RT_MAX_ENV_BYTES ||
      stdin_length > RT_MAX_STDIN_BYTES) {
    return false;
  }

  config->environment_length = environment_length;
  config->stdin_length = stdin_length;
  if (environment_length > 0) {
    config->environment_block = malloc(environment_length);
    if (config->environment_block == NULL ||
        !rt_receive_exact(control_fd, stdout_fd, stderr_fd,
                          config->environment_block, environment_length)) {
      rt_free_config(config);
      return false;
    }
  }
  if (!rt_parse_environment(config)) {
    rt_free_config(config);
    return false;
  }
  if (stdin_length > 0) {
    config->stdin_bytes = malloc(stdin_length);
    if (config->stdin_bytes == NULL ||
        !rt_receive_exact(control_fd, stdout_fd, stderr_fd, config->stdin_bytes,
                          stdin_length)) {
      rt_free_config(config);
      return false;
    }
  }
  return true;
}

static bool rt_make_pipe(int descriptors[2]) {
  size_t index;

  descriptors[0] = -1;
  descriptors[1] = -1;
  if (pipe(descriptors) != 0) {
    return false;
  }
  for (index = 0; index < 2U; index++) {
    if (descriptors[index] >= 0 && descriptors[index] <= STDERR_FILENO) {
      int replacement = fcntl(descriptors[index], F_DUPFD_CLOEXEC, 3);

      if (replacement < 0) {
        rt_close_fd(&descriptors[0]);
        rt_close_fd(&descriptors[1]);
        return false;
      }
      (void)close(descriptors[index]);
      descriptors[index] = replacement;
    }
  }
  if (!rt_set_cloexec(descriptors[0]) || !rt_set_cloexec(descriptors[1])) {
    rt_close_fd(&descriptors[0]);
    rt_close_fd(&descriptors[1]);
    return false;
  }
  return true;
}

static void rt_close_pipe_pair(int descriptors[2]) {
  rt_close_fd(&descriptors[0]);
  rt_close_fd(&descriptors[1]);
}

static int rt_add_spawn_close(posix_spawn_file_actions_t *actions, int fd) {
  return fd >= 0 ? posix_spawn_file_actions_addclose(actions, fd) : 0;
}

static bool rt_spawn_provider(const char *cwd, char *const provider_argv[],
                              char *const environment[], int control_fd,
                              int stdout_socket_fd, int stderr_socket_fd,
                              pid_t *pid_out, struct rt_run_io *io_out) {
  int stdin_pipe[2] = {-1, -1};
  int stdout_pipe[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  sigset_t defaults;
  sigset_t mask;
  short flags;
  bool actions_initialized = false;
  bool attributes_initialized = false;
  int error = 0;
  pid_t pid = -1;

  memset(io_out, 0, sizeof(*io_out));
  io_out->control_fd = control_fd;
  io_out->stdin_fd = -1;
  io_out->stdout_channel.pipe_fd = -1;
  io_out->stdout_channel.socket_fd = stdout_socket_fd;
  io_out->stderr_channel.pipe_fd = -1;
  io_out->stderr_channel.socket_fd = stderr_socket_fd;
  if (!rt_make_pipe(stdin_pipe) || !rt_make_pipe(stdout_pipe) ||
      !rt_make_pipe(stderr_pipe)) {
    rt_close_pipe_pair(stdin_pipe);
    rt_close_pipe_pair(stdout_pipe);
    rt_close_pipe_pair(stderr_pipe);
    return false;
  }
  if (!rt_set_nonblocking(stdin_pipe[1]) ||
      !rt_set_nonblocking(stdout_pipe[0]) ||
      !rt_set_nonblocking(stderr_pipe[0])) {
    error = errno;
    goto finished;
  }

  error = posix_spawn_file_actions_init(&actions);
  if (error != 0) {
    goto finished;
  }
  actions_initialized = true;
  error = posix_spawn_file_actions_addchdir_np(&actions, cwd);
  if (error == 0) {
    error =
        posix_spawn_file_actions_adddup2(&actions, stdin_pipe[0], STDIN_FILENO);
  }
  if (error == 0) {
    error = posix_spawn_file_actions_adddup2(&actions, stdout_pipe[1],
                                             STDOUT_FILENO);
  }
  if (error == 0) {
    error = posix_spawn_file_actions_adddup2(&actions, stderr_pipe[1],
                                             STDERR_FILENO);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stdin_pipe[1]);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stdout_pipe[0]);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stderr_pipe[0]);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, control_fd);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stdout_socket_fd);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stderr_socket_fd);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stdin_pipe[0]);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stdout_pipe[1]);
  }
  if (error == 0) {
    error = rt_add_spawn_close(&actions, stderr_pipe[1]);
  }
  if (error != 0) {
    goto finished;
  }

  error = posix_spawnattr_init(&attributes);
  if (error != 0) {
    goto finished;
  }
  attributes_initialized = true;
  (void)sigfillset(&defaults);
  (void)sigemptyset(&mask);
  flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF |
          POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_START_SUSPENDED |
          POSIX_SPAWN_CLOEXEC_DEFAULT;
  error = posix_spawnattr_setflags(&attributes, flags);
  if (error == 0) {
    error = posix_spawnattr_setpgroup(&attributes, 0);
  }
  if (error == 0) {
    error = posix_spawnattr_setsigdefault(&attributes, &defaults);
  }
  if (error == 0) {
    error = posix_spawnattr_setsigmask(&attributes, &mask);
  }
  if (error == 0) {
    error = posix_spawnp(&pid, provider_argv[0], &actions, &attributes,
                         provider_argv, environment);
  }

finished:
  if (attributes_initialized) {
    (void)posix_spawnattr_destroy(&attributes);
  }
  if (actions_initialized) {
    (void)posix_spawn_file_actions_destroy(&actions);
  }
  rt_close_fd(&stdin_pipe[0]);
  rt_close_fd(&stdout_pipe[1]);
  rt_close_fd(&stderr_pipe[1]);
  if (error != 0) {
    errno = error;
    rt_close_fd(&stdin_pipe[1]);
    rt_close_fd(&stdout_pipe[0]);
    rt_close_fd(&stderr_pipe[0]);
    return false;
  }
  *pid_out = pid;
  io_out->stdin_fd = stdin_pipe[1];
  io_out->stdout_channel.pipe_fd = stdout_pipe[0];
  io_out->stderr_channel.pipe_fd = stderr_pipe[0];
  return true;
}

static void rt_compact_channel(struct rt_output_channel *channel) {
  if (channel->length == 0) {
    channel->offset = 0;
  } else if (channel->offset > 0 &&
             channel->offset + channel->length == sizeof(channel->pending)) {
    memmove(channel->pending, channel->pending + channel->offset,
            channel->length);
    channel->offset = 0;
  }
}

static bool rt_flush_channel(struct rt_output_channel *channel) {
  while (channel->length > 0) {
    ssize_t result;

    if (channel->socket_fd < 0) {
      return false;
    }
    result = send(channel->socket_fd, channel->pending + channel->offset,
                  channel->length, 0);
    if (result > 0) {
      channel->offset += (size_t)result;
      channel->length -= (size_t)result;
      if (channel->length == 0) {
        channel->offset = 0;
      }
      continue;
    }
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return true;
    }
    return false;
  }
  return true;
}

static bool rt_read_channel(struct rt_output_channel *channel) {
  if (channel->pipe_fd < 0 || channel->pipe_eof) {
    return true;
  }
  rt_compact_channel(channel);
  while (channel->offset + channel->length < sizeof(channel->pending)) {
    size_t capacity =
        sizeof(channel->pending) - channel->offset - channel->length;
    ssize_t result =
        read(channel->pipe_fd,
             channel->pending + channel->offset + channel->length, capacity);

    if (result > 0) {
      channel->length += (size_t)result;
      continue;
    }
    if (result == 0) {
      channel->pipe_eof = true;
      rt_close_fd(&channel->pipe_fd);
      return true;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return true;
    }
    return false;
  }
  return true;
}

static bool rt_consume_control(int fd, bool *stop_requested,
                               bool *retry_requested) {
  uint8_t bytes[64];

  while (true) {
    ssize_t count = recv(fd, bytes, sizeof(bytes), 0);
    size_t index;

    if (count > 0) {
      for (index = 0; index < (size_t)count; index++) {
        if (bytes[index] == 'S') {
          *stop_requested = true;
        } else if (bytes[index] == 'R') {
          *retry_requested = true;
        } else {
          return false;
        }
      }
      continue;
    }
    if (count == 0) {
      return false;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return true;
    }
    return false;
  }
}

static bool rt_pump_io(struct rt_run_io *io, int timeout_ms,
                       bool *stop_requested, bool *retry_requested) {
  struct pollfd descriptors[6];
  int result;

  if (rt_owner_signal) {
    return false;
  }

  descriptors[0].fd = io->control_fd;
  descriptors[0].events = POLLIN;
  descriptors[0].revents = 0;
  descriptors[1].fd = io->stdin_fd;
  descriptors[1].events = io->stdin_fd >= 0 ? POLLOUT : 0;
  descriptors[1].revents = 0;
  descriptors[2].fd = io->stdout_channel.pipe_fd;
  descriptors[2].events =
      io->stdout_channel.pipe_fd >= 0 &&
              io->stdout_channel.offset + io->stdout_channel.length <
                  sizeof(io->stdout_channel.pending)
          ? POLLIN
          : 0;
  descriptors[2].revents = 0;
  descriptors[3].fd = io->stderr_channel.pipe_fd;
  descriptors[3].events =
      io->stderr_channel.pipe_fd >= 0 &&
              io->stderr_channel.offset + io->stderr_channel.length <
                  sizeof(io->stderr_channel.pending)
          ? POLLIN
          : 0;
  descriptors[3].revents = 0;
  descriptors[4].fd = io->stdout_channel.socket_fd;
  descriptors[4].events =
      io->stdout_channel.socket_fd >= 0
          ? (short)(POLLIN | (io->stdout_channel.length > 0 ? POLLOUT : 0))
          : 0;
  descriptors[4].revents = 0;
  descriptors[5].fd = io->stderr_channel.socket_fd;
  descriptors[5].events =
      io->stderr_channel.socket_fd >= 0
          ? (short)(POLLIN | (io->stderr_channel.length > 0 ? POLLOUT : 0))
          : 0;
  descriptors[5].revents = 0;

  result = poll(descriptors, 6, timeout_ms);
  if (result < 0) {
    return errno == EINTR && !rt_owner_signal;
  }
  if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) {
    return false;
  }
  if (descriptors[4].fd >= 0 &&
      descriptors[4].revents & (POLLERR | POLLHUP | POLLNVAL | POLLIN)) {
    return false;
  }
  if (descriptors[5].fd >= 0 &&
      descriptors[5].revents & (POLLERR | POLLHUP | POLLNVAL | POLLIN)) {
    return false;
  }
  if (descriptors[0].revents & POLLIN &&
      !rt_consume_control(io->control_fd, stop_requested, retry_requested)) {
    return false;
  }

  if (descriptors[4].revents & POLLOUT &&
      !rt_flush_channel(&io->stdout_channel)) {
    return false;
  }
  if (descriptors[5].revents & POLLOUT &&
      !rt_flush_channel(&io->stderr_channel)) {
    return false;
  }
  if (descriptors[2].revents & (POLLIN | POLLHUP) &&
      !rt_read_channel(&io->stdout_channel)) {
    return false;
  }
  if (descriptors[3].revents & (POLLIN | POLLHUP) &&
      !rt_read_channel(&io->stderr_channel)) {
    return false;
  }

  if (io->stdin_fd >= 0 &&
      descriptors[1].revents & (POLLERR | POLLHUP | POLLNVAL)) {
    rt_close_fd(&io->stdin_fd);
  } else if (io->stdin_fd >= 0 && descriptors[1].revents & POLLOUT) {
    while (io->stdin_offset < io->stdin_length) {
      ssize_t written = write(io->stdin_fd, io->stdin_bytes + io->stdin_offset,
                              io->stdin_length - io->stdin_offset);

      if (written > 0) {
        io->stdin_offset += (size_t)written;
      } else if (written < 0 && errno == EINTR) {
        continue;
      } else if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        break;
      } else {
        rt_close_fd(&io->stdin_fd);
        break;
      }
    }
    if (io->stdin_offset == io->stdin_length) {
      rt_close_fd(&io->stdin_fd);
    }
  }

  /* A flush followed by a read avoids an avoidable one-poll latency. */
  if (!rt_flush_channel(&io->stdout_channel) ||
      !rt_flush_channel(&io->stderr_channel)) {
    return false;
  }
  return true;
}

static bool rt_reap_provider(pid_t pid, bool *reaped, int *status_out) {
  int status;
  pid_t result;

  if (*reaped) {
    return true;
  }
  do {
    result = waitpid(pid, &status, WNOHANG);
  } while (result < 0 && errno == EINTR);
  if (result == pid) {
    *reaped = true;
    *status_out = status;
    return true;
  }
  return result == 0;
}

static bool rt_control_peer_alive(int fd) {
  struct pollfd descriptor;
  uint8_t byte;
  ssize_t result;

  descriptor.fd = fd;
  descriptor.events = POLLIN;
  descriptor.revents = 0;
  if (poll(&descriptor, 1, 0) < 0) {
    return errno == EINTR;
  }
  if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) {
    return false;
  }
  if (!(descriptor.revents & POLLIN)) {
    return true;
  }
  result = recv(fd, &byte, 1, MSG_PEEK);
  return result > 0 ||
         (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
}

static void rt_close_output_channel(struct rt_output_channel *channel) {
  rt_close_fd(&channel->pipe_fd);
  if (channel->socket_fd >= 0) {
    (void)shutdown(channel->socket_fd, SHUT_WR);
    rt_close_fd(&channel->socket_fd);
  }
  channel->pipe_eof = true;
  channel->offset = 0;
  channel->length = 0;
}

static void rt_close_outputs(struct rt_run_io *io) {
  rt_close_output_channel(&io->stdout_channel);
  rt_close_output_channel(&io->stderr_channel);
}

static bool rt_finish_outputs(struct rt_run_io *io) {
  bool stdout_alive = io->stdout_channel.socket_fd >= 0 &&
                      rt_output_peer_alive(io->stdout_channel.socket_fd);
  bool stderr_alive = io->stderr_channel.socket_fd >= 0 &&
                      rt_output_peer_alive(io->stderr_channel.socket_fd);
  bool stdout_shutdown =
      stdout_alive && shutdown(io->stdout_channel.socket_fd, SHUT_WR) == 0;
  bool stderr_shutdown =
      stderr_alive && shutdown(io->stderr_channel.socket_fd, SHUT_WR) == 0;

  rt_close_fd(&io->stdout_channel.pipe_fd);
  rt_close_fd(&io->stderr_channel.pipe_fd);
  rt_close_fd(&io->stdout_channel.socket_fd);
  rt_close_fd(&io->stderr_channel.socket_fd);
  io->stdout_channel.pipe_eof = true;
  io->stderr_channel.pipe_eof = true;
  return stdout_shutdown && stderr_shutdown;
}

static void rt_abandon_io(struct rt_run_io *io) {
  rt_close_fd(&io->stdin_fd);
  rt_close_outputs(io);
  rt_close_fd(&io->control_fd);
}

static void rt_best_effort_flush_then_close_outputs(struct rt_run_io *io) {
  uint64_t start = rt_monotonic_ms();

  while ((io->stdout_channel.length > 0 || io->stderr_channel.length > 0) &&
         rt_monotonic_ms() - start < 250U) {
    struct pollfd descriptors[2];

    descriptors[0].fd = io->stdout_channel.socket_fd;
    descriptors[0].events = io->stdout_channel.length > 0 ? POLLOUT : 0;
    descriptors[0].revents = 0;
    descriptors[1].fd = io->stderr_channel.socket_fd;
    descriptors[1].events = io->stderr_channel.length > 0 ? POLLOUT : 0;
    descriptors[1].revents = 0;
    if (poll(descriptors, 2, (int)RT_POLL_INTERVAL_MS) < 0 && errno != EINTR) {
      break;
    }
    if (descriptors[0].revents & POLLOUT) {
      if (!rt_flush_channel(&io->stdout_channel)) {
        break;
      }
    }
    if (descriptors[1].revents & POLLOUT) {
      if (!rt_flush_channel(&io->stderr_channel)) {
        break;
      }
    }
  }
  rt_close_fd(&io->stdin_fd);
  rt_close_outputs(io);
}

static bool rt_outputs_drained(const struct rt_run_io *io) {
  return io->stdout_channel.pipe_eof && io->stdout_channel.length == 0 &&
         io->stderr_channel.pipe_eof && io->stderr_channel.length == 0;
}

static bool rt_wait_and_drain(struct rt_run_io *io, pid_t provider_pid,
                              bool *provider_reaped, int *provider_status) {
  bool stop_requested = false;
  bool retry_requested = false;

  rt_close_fd(&io->stdin_fd);
  while (!*provider_reaped || !rt_outputs_drained(io)) {
    if (!rt_reap_provider(provider_pid, provider_reaped, provider_status) ||
        !rt_pump_io(io, 250, &stop_requested, &retry_requested)) {
      return false;
    }
  }
  return true;
}

static bool rt_attest_suspended_provider(pid_t pid, uint64_t expected_cid,
                                         struct rt_identity *identity_out) {
  uint64_t start = rt_monotonic_ms();

  while (rt_monotonic_ms() - start < 1000U) {
    struct rt_identity identity;
    enum rt_query_result result = rt_read_identity(pid, &identity);

    if (result == RT_QUERY_OK) {
      pid_t process_group = getpgid(pid);

      if (identity.resource_cid != expected_cid || identity.status != SSTOP ||
          process_group != pid) {
        return false;
      }
      *identity_out = identity;
      return true;
    } else if (result == RT_QUERY_GONE) {
      return false;
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }
  return false;
}

static bool rt_send_exit_line(int control_fd, int status) {
  if (WIFEXITED(status)) {
    return rt_send_formatted_line(control_fd, "EXIT %d 0\n",
                                  WEXITSTATUS(status));
  }
  if (WIFSIGNALED(status)) {
    return rt_send_formatted_line(control_fd, "EXIT -1 %d\n", WTERMSIG(status));
  }
  return false;
}

static int rt_run_guardian(const char *control_path, const char *stdout_path,
                           const char *stderr_path,
                           char nonce[RT_NONCE_BUFFER_BYTES],
                           const char *cwd, char *const provider_argv[],
                           const struct rt_identity *self_identity) {
  int control_fd = -1;
  int stdout_fd = -1;
  int stderr_fd = -1;
  struct rt_run_config config;
  struct rt_run_io io;
  struct rt_identity provider_identity;
  pid_t provider_pid = -1;
  bool provider_reaped = false;
  int provider_status = 0;
  bool owner_connected = false;
  bool outputs_closed_for_failure = false;
  bool stop_requested = false;
  bool retry_requested = false;
  enum rt_cleanup_result cleanup_result;
  int exit_code = 1;
#if defined(ROUNDTABLE_NATIVE_HELPER_TEST_FORCE_FIRST_CLEANUP_FAILURE)
  bool force_first_cleanup_failure = true;
#endif

  memset(&config, 0, sizeof(config));
  memset(&io, 0, sizeof(io));
  io.control_fd = -1;
  io.stdin_fd = -1;
  io.stdout_channel.pipe_fd = -1;
  io.stdout_channel.socket_fd = -1;
  io.stderr_channel.pipe_fd = -1;
  io.stderr_channel.socket_fd = -1;

  control_fd = rt_connect_unix_socket(control_path);
  if (control_fd < 0) {
    goto finished;
  }
  stdout_fd = rt_connect_unix_socket(stdout_path);
  if (stdout_fd < 0) {
    goto finished;
  }
  stderr_fd = rt_connect_unix_socket(stderr_path);
  if (stderr_fd < 0) {
    goto finished;
  }
  if (!rt_send_formatted_line(stdout_fd, "RTOUT001 %s stdout\n", nonce) ||
      !rt_send_formatted_line(stderr_fd, "RTOUT001 %s stderr\n", nonce) ||
      !rt_send_formatted_line(
          control_fd, "HELLO %s %d %u %llu %llu\n", nonce, self_identity->pid,
          self_identity->pidversion,
          (unsigned long long)self_identity->uniqueid,
          (unsigned long long)self_identity->resource_cid)) {
    rt_secure_zero(nonce, RT_NONCE_BUFFER_BYTES);
    goto finished;
  }
  rt_secure_zero(nonce, RT_NONCE_BUFFER_BYTES);
  owner_connected = true;
  if (!rt_receive_config(control_fd, stdout_fd, stderr_fd, &config)) {
    goto finished;
  }
  if (!rt_output_peer_alive(stdout_fd) || !rt_output_peer_alive(stderr_fd)) {
    goto finished;
  }

  if (!rt_spawn_provider(cwd, provider_argv, config.environment, control_fd,
                         stdout_fd, stderr_fd, &provider_pid, &io)) {
    (void)rt_send_formatted_line(control_fd, "ERROR spawn %d\n", errno);
    goto finished;
  }
  control_fd = -1;
  stdout_fd = -1;
  stderr_fd = -1;
  io.stdin_bytes = config.stdin_bytes;
  io.stdin_length = config.stdin_length;
  if (io.stdin_length == 0) {
    rt_close_fd(&io.stdin_fd);
  }

  if (!rt_attest_suspended_provider(provider_pid, self_identity->resource_cid,
                                    &provider_identity)) {
    (void)rt_send_formatted_line(io.control_fd, "ERROR attest %d\n", errno);
    stop_requested = true;
    goto cleanup;
  }
  if (!rt_send_formatted_line(
          io.control_fd, "START %d %llu\n", provider_pid,
          (unsigned long long)self_identity->resource_cid)) {
    owner_connected = false;
    goto cleanup;
  }
  if (rt_signal_execution(&provider_identity, SIGCONT) != RT_SIGNAL_SENT) {
    (void)rt_send_formatted_line(io.control_fd, "ERROR continue %d\n", errno);
    stop_requested = true;
    goto cleanup;
  }

  while (owner_connected && !stop_requested && !provider_reaped) {
    if (!rt_pump_io(&io, 250, &stop_requested, &retry_requested) ||
        !rt_reap_provider(provider_pid, &provider_reaped, &provider_status)) {
      owner_connected = false;
      break;
    }
  }

cleanup:
  rt_close_fd(&io.stdin_fd);
  if (!owner_connected) {
    rt_abandon_io(&io);
  }
  while (true) {
#if defined(ROUNDTABLE_NATIVE_HELPER_TEST_FORCE_FIRST_CLEANUP_FAILURE)
    if (force_first_cleanup_failure) {
      cleanup_result = RT_CLEANUP_FAILED;
      force_first_cleanup_failure = false;
    } else {
      cleanup_result =
          rt_cleanup_coalition(self_identity->resource_cid, self_identity,
                               RT_INTERNAL_GRACE_MS, RT_INTERNAL_CONFIRM_MS);
    }
#else
    cleanup_result =
        rt_cleanup_coalition(self_identity->resource_cid, self_identity,
                             RT_INTERNAL_GRACE_MS, RT_INTERNAL_CONFIRM_MS);
#endif
    if (cleanup_result == RT_CLEANUP_CONFIRMED) {
      break;
    }

    if (!owner_connected) {
      rt_sleep_ms(250U);
      continue;
    }
    if (!outputs_closed_for_failure) {
      rt_best_effort_flush_then_close_outputs(&io);
      outputs_closed_for_failure = true;
    }
    if (!rt_send_formatted_line(io.control_fd, "TREE failed\n")) {
      owner_connected = false;
      rt_abandon_io(&io);
      rt_sleep_ms(250U);
      continue;
    }

    retry_requested = false;
    stop_requested = false;
    while (owner_connected && !retry_requested && !stop_requested) {
      if (!rt_reap_provider(provider_pid, &provider_reaped, &provider_status) ||
          !rt_pump_io(&io, 250, &stop_requested, &retry_requested)) {
        owner_connected = false;
      }
    }
    if (!owner_connected) {
      rt_abandon_io(&io);
    }
  }

  if (!owner_connected) {
    if (!provider_reaped) {
      int status;
      pid_t waited;

      do {
        waited = waitpid(provider_pid, &status, 0);
      } while (waited < 0 && errno == EINTR);
      if (waited == provider_pid) {
        provider_reaped = true;
        provider_status = status;
      }
    }
    exit_code = 0;
    goto finished;
  }

  if (!outputs_closed_for_failure) {
    if (!rt_wait_and_drain(&io, provider_pid, &provider_reaped,
                           &provider_status)) {
      rt_abandon_io(&io);
      exit_code = 0;
      goto finished;
    }
    if (!rt_finish_outputs(&io)) {
      rt_abandon_io(&io);
      exit_code = 0;
      goto finished;
    }
  } else if (!provider_reaped) {
    int status;
    pid_t waited;

    do {
      waited = waitpid(provider_pid, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited == provider_pid) {
      provider_reaped = true;
      provider_status = status;
    }
  }

  if (!provider_reaped || !rt_control_peer_alive(io.control_fd) ||
      !rt_send_exit_line(io.control_fd, provider_status) ||
      !rt_send_formatted_line(io.control_fd, "TREE confirmed\n")) {
    rt_abandon_io(&io);
    exit_code = 0;
    goto finished;
  }
  rt_close_fd(&io.control_fd);
  exit_code = 0;

finished:
  rt_secure_zero(nonce, RT_NONCE_BUFFER_BYTES);
  if (provider_pid <= 0) {
    rt_close_fd(&control_fd);
    rt_close_fd(&stdout_fd);
    rt_close_fd(&stderr_fd);
  } else {
    rt_abandon_io(&io);
  }
  rt_free_config(&config);
  return exit_code;
}

static bool rt_watch_identity_equal(const struct rt_identity *left,
                                    const struct rt_identity *right) {
  return left->pid == right->pid && left->pidversion == right->pidversion &&
         left->uniqueid == right->uniqueid &&
         left->resource_cid == right->resource_cid;
}

static bool rt_watch_guardian_matches(
    const struct rt_identity *expected, enum rt_query_result *query_out) {
  struct rt_identity current;
  enum rt_query_result query = rt_read_identity(expected->pid, &current);

  *query_out = query;
  return query == RT_QUERY_OK && rt_watch_identity_equal(&current, expected);
}

static bool rt_attest_watch_target(const struct rt_identity *expected) {
  uint64_t start = rt_monotonic_ms();

  if (start == 0) {
    return false;
  }
  while (rt_monotonic_ms() - start < 1000U) {
    struct rt_identity current;
    struct rt_snapshot snapshot;
    enum rt_query_result identity_query =
        rt_read_identity(expected->pid, &current);

    if (identity_query == RT_QUERY_GONE ||
        (identity_query == RT_QUERY_OK &&
         !rt_watch_identity_equal(&current, expected))) {
      return false;
    }
    if (identity_query == RT_QUERY_OK) {
      enum rt_query_result snapshot_query =
          rt_take_snapshot(expected->resource_cid, &snapshot);

      if (snapshot_query == RT_QUERY_GONE) {
        return false;
      }
      if (snapshot_query == RT_QUERY_OK && snapshot.complete) {
        size_t index;

        for (index = 0; index < snapshot.count; index++) {
          if (rt_watch_identity_equal(&snapshot.members[index], expected)) {
            return rt_signal_execution(&current, SIGCONT) == RT_SIGNAL_SENT;
          }
        }
      }
    }
    rt_sleep_ms(RT_POLL_INTERVAL_MS);
  }
  return false;
}

static int rt_watch_target(const char *control_path,
                           char nonce[RT_NONCE_BUFFER_BYTES],
                           const struct rt_identity *target_guardian,
                           uint32_t grace_ms, uint32_t confirm_ms,
                           const struct rt_identity *self_identity) {
  int control_fd = -1;
  bool owner_connected = false;
  bool cleanup_requested = false;
  enum rt_query_result guardian_query;

  if (self_identity->resource_cid == target_guardian->resource_cid ||
      !rt_attest_watch_target(target_guardian)) {
    rt_secure_zero(nonce, RT_NONCE_BUFFER_BYTES);
    return 1;
  }

  control_fd = rt_connect_unix_socket(control_path);
  if (control_fd >= 0) {
    owner_connected = true;
    if (!rt_send_formatted_line(
            control_fd, "RTWATCH001 %s READY %d %u %llu %llu\n", nonce,
            self_identity->pid, self_identity->pidversion,
            (unsigned long long)self_identity->uniqueid,
            (unsigned long long)self_identity->resource_cid)) {
      owner_connected = false;
      rt_close_fd(&control_fd);
      cleanup_requested = true;
    }
  } else {
    cleanup_requested = true;
  }
  rt_secure_zero(nonce, RT_NONCE_BUFFER_BYTES);

  while (!cleanup_requested) {
    struct pollfd descriptor;
    int poll_result;

    if (rt_owner_signal) {
      owner_connected = false;
      rt_close_fd(&control_fd);
      break;
    }
    descriptor.fd = control_fd;
    descriptor.events = POLLIN;
    descriptor.revents = 0;
    poll_result = poll(&descriptor, 1, 250);
    if (poll_result < 0) {
      if (errno != EINTR) {
        owner_connected = false;
        rt_close_fd(&control_fd);
        cleanup_requested = true;
      }
    } else if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) {
      owner_connected = false;
      rt_close_fd(&control_fd);
      cleanup_requested = true;
    } else if (descriptor.revents & POLLIN) {
      uint8_t bytes[2];
      ssize_t count = recv(control_fd, bytes, sizeof(bytes), 0);

      if (count == 1 && bytes[0] == (uint8_t)'C') {
        cleanup_requested = true;
      } else if (count < 0 &&
                 (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
        /* Retry the owner and guardian observations. */
      } else {
        owner_connected = false;
        rt_close_fd(&control_fd);
        cleanup_requested = true;
      }
    }

    if (!cleanup_requested) {
      bool guardian_matches =
          rt_watch_guardian_matches(target_guardian, &guardian_query);

      if (guardian_query == RT_QUERY_GONE ||
          (guardian_query == RT_QUERY_OK && !guardian_matches)) {
        cleanup_requested = true;
      }
      /* A transient query error never releases or abandons the target CID. */
    }
  }

  while (true) {
    enum rt_cleanup_result cleanup =
        rt_cleanup_coalition(target_guardian->resource_cid, NULL, grace_ms,
                             confirm_ms);

    if (cleanup == RT_CLEANUP_CONFIRMED) {
      if (owner_connected) {
        (void)rt_send_formatted_line(control_fd, "TREE confirmed\n");
      }
      rt_close_fd(&control_fd);
      return 0;
    }
    if (owner_connected &&
        !rt_send_formatted_line(control_fd, "TREE failed\n")) {
      owner_connected = false;
      rt_close_fd(&control_fd);
    }
    rt_sleep_ms(250U);
  }
}

static void rt_print_usage(FILE *stream) {
  (void)fprintf(
      stream,
      "usage:\n"
      "  roundtable-macos-process-helper inspect <pid>\n"
      "  roundtable-macos-process-helper terminate <cid> <graceMs> "
      "<killConfirmMs>\n"
      "  roundtable-macos-process-helper isolate <cid> <guardianPid> "
      "<guardianPidVersion> <guardianUniqueId> <graceMs> <killConfirmMs>\n"
      "  roundtable-macos-process-helper watch <controlSocket> "
      "<nonceSecretFile> "
      "<targetCid> <guardianPid> <guardianPidVersion> <guardianUniqueId> "
      "<graceMs> <killConfirmMs>\n"
      "  roundtable-macos-process-helper run <controlSocket> <stdoutSocket> "
      "<stderrSocket> <nonceSecretFile> <cwd> <command> [args...]\n");
}

int main(int argc, char *argv[]) {
  struct rt_identity self_identity;
  const char *trace_value = getenv("ROUNDTABLE_NATIVE_HELPER_TRACE");

  rt_trace_enabled = trace_value != NULL && strcmp(trace_value, "1") == 0;
  if (!rt_install_signal_handlers()) {
    (void)fprintf(stderr, "failed to install signal handlers\n");
    return 70;
  }
  if (!rt_load_and_probe_abi(&self_identity)) {
    (void)fprintf(stderr, "unsupported macOS coalition/process ABI\n");
    return 70;
  }

  if (argc == 3 && strcmp(argv[1], "inspect") == 0) {
    pid_t pid;
    struct rt_identity identity;

    if (!rt_parse_pid(argv[2], &pid) ||
        rt_read_identity(pid, &identity) != RT_QUERY_OK) {
      (void)fprintf(stderr, "unable to inspect process\n");
      return 1;
    }
    (void)printf("INSPECT %d %u %llu %llu\n", identity.pid, identity.pidversion,
                 (unsigned long long)identity.uniqueid,
                 (unsigned long long)identity.resource_cid);
    return 0;
  }

  if (argc == 5 && strcmp(argv[1], "terminate") == 0) {
    uint64_t cid;
    uint32_t grace_ms;
    uint32_t confirm_ms;
    enum rt_cleanup_result result;

    if (!rt_parse_u64(argv[2], &cid) || cid == 0 ||
        !rt_parse_ms(argv[3], &grace_ms) ||
        !rt_parse_ms(argv[4], &confirm_ms) ||
        cid == self_identity.resource_cid) {
      (void)printf("TREE failed\n");
      return 1;
    }
    result = rt_cleanup_coalition(cid, NULL, grace_ms, confirm_ms);
    if (result == RT_CLEANUP_CONFIRMED) {
      (void)printf("TREE confirmed\n");
      return 0;
    }
    (void)printf("TREE failed\n");
    return 1;
  }

  if (argc == 8 && strcmp(argv[1], "isolate") == 0) {
    uint64_t cid;
    pid_t guardian_pid;
    uint32_t guardian_pidversion;
    uint64_t guardian_uniqueid;
    uint32_t grace_ms;
    uint32_t confirm_ms;
    struct rt_identity guardian_identity;
    enum rt_cleanup_result result;

    if (!rt_parse_u64(argv[2], &cid) || cid == 0 ||
        !rt_parse_pid(argv[3], &guardian_pid) ||
        !rt_parse_ms(argv[4], &guardian_pidversion) ||
        !rt_parse_u64(argv[5], &guardian_uniqueid) ||
        guardian_uniqueid == 0 || !rt_parse_ms(argv[6], &grace_ms) ||
        !rt_parse_ms(argv[7], &confirm_ms) ||
        rt_read_identity(guardian_pid, &guardian_identity) != RT_QUERY_OK ||
        guardian_identity.pid != guardian_pid ||
        guardian_identity.pidversion != guardian_pidversion ||
        guardian_identity.uniqueid != guardian_uniqueid ||
        guardian_identity.resource_cid != cid) {
      (void)printf("TREE failed\n");
      return 1;
    }
    result =
        rt_cleanup_coalition(cid, &guardian_identity, grace_ms, confirm_ms);
    if (result == RT_CLEANUP_CONFIRMED) {
      (void)printf("TREE isolated\n");
      return 0;
    }
    (void)printf("TREE failed\n");
    return 1;
  }

  if (argc == 10 && strcmp(argv[1], "watch") == 0) {
    uint64_t target_cid;
    pid_t guardian_pid;
    uint32_t guardian_pidversion;
    uint64_t guardian_uniqueid;
    uint32_t grace_ms;
    uint32_t confirm_ms;
    struct rt_identity target_guardian;
    char nonce[RT_NONCE_BUFFER_BYTES];
    int watch_result;

    if (!rt_parse_u64(argv[4], &target_cid) || target_cid == 0 ||
        !rt_parse_pid(argv[5], &guardian_pid) ||
        !rt_parse_ms(argv[6], &guardian_pidversion) ||
        !rt_parse_u64(argv[7], &guardian_uniqueid) ||
        guardian_uniqueid == 0 || !rt_parse_ms(argv[8], &grace_ms) ||
        !rt_parse_ms(argv[9], &confirm_ms) ||
        !rt_read_nonce_secret_file(argv[3], nonce)) {
      return 1;
    }
    target_guardian.pid = guardian_pid;
    target_guardian.pidversion = guardian_pidversion;
    target_guardian.uniqueid = guardian_uniqueid;
    target_guardian.resource_cid = target_cid;
    target_guardian.status = 0;
    watch_result = rt_watch_target(argv[2], nonce, &target_guardian, grace_ms,
                                   confirm_ms, &self_identity);
    rt_secure_zero(nonce, sizeof(nonce));
    return watch_result;
  }

  if (argc >= 8 && strcmp(argv[1], "run") == 0 && argv[6][0] != '\0' &&
      argv[7][0] != '\0') {
    char nonce[RT_NONCE_BUFFER_BYTES];
    int run_result;

    if (!rt_read_nonce_secret_file(argv[5], nonce)) {
      return 1;
    }
    run_result = rt_run_guardian(argv[2], argv[3], argv[4], nonce, argv[6],
                                 &argv[7], &self_identity);
    rt_secure_zero(nonce, sizeof(nonce));
    return run_result;
  }

  rt_print_usage(stderr);
  return 64;
}
