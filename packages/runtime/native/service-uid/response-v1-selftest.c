#include "response-v1.h"
#include "generated/macos-service-uid-v1-contract.h"

#include <stdio.h>
#include <stdint.h>

static void set_base(xpc_object_t d) {
    xpc_dictionary_set_string(d, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(d, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(d, "requestId", "request-1");
    xpc_dictionary_set_string(d, "serviceInstanceId", "service-1");
    xpc_dictionary_set_uint64(d, "brokerUid", 0U);
    xpc_dictionary_set_uint64(d, "executionUid", 502U);
    xpc_dictionary_set_string(d, "type", "status");
    xpc_dictionary_set_bool(d, "ok", true);
    xpc_dictionary_set_uint64(d, "maxConcurrency", 1U);
    xpc_dictionary_set_string(d, "secretTransport", RT_MACOS_SERVICE_UID_V1_SECRET_TRANSPORT);
    xpc_object_t seat = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(seat, "state", "idle");
    xpc_dictionary_set_value(seat, "leaseId", xpc_null_create());
    xpc_dictionary_set_value(seat, "executionId", xpc_null_create());
    xpc_dictionary_set_value(d, "seat", seat);
    xpc_release(seat);
}

int main(void) {
    xpc_object_t response = xpc_dictionary_create(NULL, NULL, 0U);
    set_base(response);
    bool ok = rt_service_uid_v1_parse_status_response(response, "request-1");
    ok = ok && rt_service_uid_v1_response_identity_matches(response, 0U, 502U);
    ok = ok && !rt_service_uid_v1_response_identity_matches(response, 1U, 502U);
    ok = ok && !rt_service_uid_v1_response_identity_matches(response, 0U, UINT64_MAX);
    xpc_dictionary_set_string(response, "unexpected", "field");
    ok = ok && !rt_service_uid_v1_parse_status_response(response, "request-1");
    xpc_dictionary_set_string(response, "serviceInstanceId", "service-1");
    xpc_dictionary_set_uint64(response, "brokerUid", 0U);
    xpc_dictionary_set_string(response, "unexpected", "");
    ok = ok && !rt_service_uid_v1_parse_status_response(response, "request-1");
    xpc_dictionary_set_string(response, "serviceInstanceId", "service-1");
    xpc_dictionary_set_uint64(response, "brokerUid", UINT64_C(2147483648));
    xpc_dictionary_set_value(response, "unexpected", NULL);
    ok = ok && !rt_service_uid_v1_parse_status_response(response, "request-1");
    xpc_release(response);

    xpc_object_t failure = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(failure, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(failure, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(failure, "requestId", "request-2");
    xpc_dictionary_set_string(failure, "serviceInstanceId", "service-1");
    xpc_dictionary_set_uint64(failure, "brokerUid", 0U);
    xpc_dictionary_set_uint64(failure, "executionUid", 502U);
    xpc_dictionary_set_string(failure, "type", "status");
    xpc_dictionary_set_bool(failure, "ok", false);
    xpc_dictionary_set_string(failure, "error", "invalid_request");
    xpc_object_t quarantined = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(quarantined, "state", "quarantined");
    xpc_dictionary_set_value(quarantined, "leaseId", xpc_null_create());
    xpc_dictionary_set_value(quarantined, "executionId", xpc_null_create());
    xpc_dictionary_set_value(failure, "seat", quarantined);
    xpc_release(quarantined);
    ok = ok && rt_service_uid_v1_parse_status_response(failure, "request-2");
    xpc_dictionary_set_string(failure, "error", "unknown_error");
    ok = ok && !rt_service_uid_v1_parse_status_response(failure, "request-2");
    xpc_release(failure);
    if (ok) puts("service-uid-v1 response self-test ok");
    return ok ? 0 : 1;
}
