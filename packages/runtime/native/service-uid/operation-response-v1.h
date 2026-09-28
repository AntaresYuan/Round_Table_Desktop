#ifndef ROUNDTABLE_SERVICE_UID_V1_OPERATION_RESPONSE_H
#define ROUNDTABLE_SERVICE_UID_V1_OPERATION_RESPONSE_H

#include <stdbool.h>
#include <stddef.h>
#include "protocol-v1.h"

/* Validates the operation response envelope and exact per-operation keys.
 * The parser never extracts secret bytes; callers may inspect the XPC object
 * only after this function returns true. */
bool rt_service_uid_v1_parse_operation_response(
    xpc_object_t response,
    const rt_service_uid_v1_request_t *request
);

#endif
