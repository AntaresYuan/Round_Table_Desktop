#ifndef ROUNDTABLE_SERVICE_UID_BOOTSTRAP_PROBE_PROTOCOL_H
#define ROUNDTABLE_SERVICE_UID_BOOTSTRAP_PROBE_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <xpc/xpc.h>

/*
 * Connectivity and peer-authentication probe only. This is deliberately wire
 * incompatible with the macos-service-uid-v1 lifecycle contract.
 */
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_CONTRACT "bootstrap-probe-v0"
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_MACH_SERVICE \
    "com.roundtable.runtime.service-uid-bootstrap-probe-v0"
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_VERSION UINT64_C(0)
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_BROKER_VERSION \
    "service-uid-bootstrap-probe-v0"
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES 64U
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUIREMENT_BYTES 4096U
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INVALID_REQUEST "invalid_request"
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_UNAUTHORIZED "unauthorized"
#define RT_SERVICE_UID_BOOTSTRAP_PROBE_ERROR_INTERNAL "internal_error"

typedef enum {
    RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_INVALID = 0,
    RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_PING = 1,
    RT_SERVICE_UID_BOOTSTRAP_PROBE_OPERATION_STATUS = 2,
} rt_service_uid_bootstrap_probe_operation_t;

typedef struct {
    char request_id[RT_SERVICE_UID_BOOTSTRAP_PROBE_MAX_REQUEST_ID_BYTES + 1U];
    rt_service_uid_bootstrap_probe_operation_t operation;
} rt_service_uid_bootstrap_probe_request_t;

typedef struct {
    uint64_t peer_euid;
    uint64_t peer_audit_session;
} rt_service_uid_bootstrap_probe_success_t;

const char *rt_service_uid_bootstrap_probe_operation_name(
    rt_service_uid_bootstrap_probe_operation_t operation
);

bool rt_service_uid_bootstrap_probe_populate_request(
    xpc_object_t message,
    const char *request_id,
    rt_service_uid_bootstrap_probe_operation_t operation
);

bool rt_service_uid_bootstrap_probe_parse_request(
    xpc_object_t message,
    rt_service_uid_bootstrap_probe_request_t *request
);

const char *rt_service_uid_bootstrap_probe_safe_request_id(xpc_object_t message);

bool rt_service_uid_bootstrap_probe_populate_success(
    xpc_object_t response,
    const rt_service_uid_bootstrap_probe_request_t *request,
    const char *security_mode,
    uint64_t peer_euid,
    uint64_t peer_audit_session
);

bool rt_service_uid_bootstrap_probe_parse_success(
    xpc_object_t response,
    const rt_service_uid_bootstrap_probe_request_t *request,
    const char *expected_security_mode,
    rt_service_uid_bootstrap_probe_success_t *success
);

bool rt_service_uid_bootstrap_probe_populate_error(
    xpc_object_t response,
    const char *request_id,
    const char *error_code
);

bool rt_service_uid_bootstrap_probe_parse_error(
    xpc_object_t response,
    const char *expected_request_id,
    const char **error_code
);

#endif
