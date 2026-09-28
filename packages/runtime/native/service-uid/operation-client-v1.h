#ifndef ROUNDTABLE_SERVICE_UID_V1_OPERATION_CLIENT_H
#define ROUNDTABLE_SERVICE_UID_V1_OPERATION_CLIENT_H

#include <stdbool.h>
#include <stdint.h>
#include <xpc/xpc.h>

#include "protocol-v1.h"

/* Performs one bounded request/reply on the reserved v1 service. The returned
 * response is retained for the caller and has already passed the strict
 * operation response validator. A prepare request may carry exactly one
 * caller-owned FD; the XPC transport duplicates it. */
bool rt_service_uid_v1_operation_round_trip(
    xpc_object_t request,
    const char *accepted_broker_requirement,
    int secret_fd,
    uint64_t timeout_seconds,
    uint64_t expected_broker_uid,
    uint64_t expected_execution_uid,
    xpc_object_t *response
);

#endif
