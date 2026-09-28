#ifndef ROUNDTABLE_SERVICE_UID_ISOLATION_CANARY_INPUT_H
#define ROUNDTABLE_SERVICE_UID_ISOLATION_CANARY_INPUT_H

#include <stdbool.h>
#include <sys/types.h>

#define RT_ISOLATION_CANARY_SCHEMA_VERSION 1U
#define RT_ISOLATION_CANARY_RUN_ID_BYTES 32U
#define RT_ISOLATION_CANARY_MAX_PATH_BYTES 1023U
#define RT_ISOLATION_CANARY_MAX_LABEL_BYTES 127U
#define RT_ISOLATION_CANARY_LABEL_PREFIX \
    "com.roundtable.runtime.isolation-canary.host."
#define RT_ISOLATION_CANARY_WRITE_PREFIX \
    ".roundtable-service-uid-canary-"

typedef struct {
    pid_t host_pid;
    uid_t host_uid;
    char launchd_label[RT_ISOLATION_CANARY_MAX_LABEL_BYTES + 1U];
    char unix_socket_path[RT_ISOLATION_CANARY_MAX_PATH_BYTES + 1U];
    char host_canary_path[RT_ISOLATION_CANARY_MAX_PATH_BYTES + 1U];
    char staging_directory[RT_ISOLATION_CANARY_MAX_PATH_BYTES + 1U];
    char run_id[RT_ISOLATION_CANARY_RUN_ID_BYTES + 1U];
} rt_isolation_canary_input_t;

bool rt_isolation_canary_parse_input(
    int argument_count,
    const char *const arguments[],
    rt_isolation_canary_input_t *input
);

#endif
