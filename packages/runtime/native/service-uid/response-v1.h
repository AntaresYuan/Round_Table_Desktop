#ifndef ROUNDTABLE_SERVICE_UID_V1_RESPONSE_H
#define ROUNDTABLE_SERVICE_UID_V1_RESPONSE_H

#include <stdbool.h>
#include <xpc/xpc.h>

bool rt_service_uid_v1_parse_status_response(
    xpc_object_t response,
    const char *request_id
);

/* Binds a validated response to the independently configured broker and
 * execution identities. UINT64_MAX is reserved for “not configured”. */
bool rt_service_uid_v1_response_identity_matches(
    xpc_object_t response,
    uint64_t expected_broker_uid,
    uint64_t expected_execution_uid
);

#endif
