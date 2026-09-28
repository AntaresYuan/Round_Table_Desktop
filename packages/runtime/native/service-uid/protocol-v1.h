#ifndef ROUNDTABLE_SERVICE_UID_V1_PROTOCOL_H
#define ROUNDTABLE_SERVICE_UID_V1_PROTOCOL_H

#include <stdbool.h>
#include <stdint.h>
#include <xpc/xpc.h>

#include "generated/macos-service-uid-v1-contract.h"

#define RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES 127U
#define RT_SERVICE_UID_V1_MAX_SHORT_IDENTIFIER_BYTES 63U
#define RT_SERVICE_UID_V1_MAX_REQUEST_ID_BYTES 127U

typedef enum {
    RT_SERVICE_UID_V1_REQUEST_INVALID = 0,
    RT_SERVICE_UID_V1_REQUEST_STATUS = 1,
    RT_SERVICE_UID_V1_REQUEST_PREPARE = 2,
    RT_SERVICE_UID_V1_REQUEST_START = 3,
    RT_SERVICE_UID_V1_REQUEST_STOP = 4,
    RT_SERVICE_UID_V1_REQUEST_CLEANUP = 5,
} rt_service_uid_v1_request_type_t;

typedef struct {
    rt_service_uid_v1_request_type_t type;
    char request_id[RT_SERVICE_UID_V1_MAX_REQUEST_ID_BYTES + 1U];
    char lease_id[RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES + 1U];
    char execution_id[RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES + 1U];
    char preparation_id[RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES + 1U];
    char workload_kind[16U];
    char provider[32U];
    char grant_id[RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES + 1U];
    uint64_t grant_revision;
    char secret_channel_id[RT_SERVICE_UID_V1_MAX_IDENTIFIER_BYTES + 1U];
    uint64_t secret_fd_index;
    char stop_reason[16U];
} rt_service_uid_v1_request_t;

bool rt_service_uid_v1_parse_request(
    xpc_object_t message,
    rt_service_uid_v1_request_t *request
);

bool rt_service_uid_v1_populate_status_request(
    xpc_object_t message,
    const char *request_id
);

bool rt_service_uid_v1_populate_prepare_request(
    xpc_object_t message,
    const char *request_id,
    const char *lease_id,
    const char *execution_id,
    const char *provider,
    const char *grant_id,
    uint64_t grant_revision,
    const char *secret_channel_id
);

bool rt_service_uid_v1_populate_start_request(
    xpc_object_t message,
    const char *request_id,
    const char *lease_id,
    const char *execution_id,
    const char *preparation_id
);

bool rt_service_uid_v1_populate_stop_request(
    xpc_object_t message,
    const char *request_id,
    const char *lease_id,
    const char *execution_id,
    const char *reason
);

bool rt_service_uid_v1_populate_cleanup_request(
    xpc_object_t message,
    const char *request_id,
    const char *lease_id,
    const char *execution_id
);

bool rt_service_uid_v1_attach_secret_fd(xpc_object_t message, int secret_fd);

#endif
