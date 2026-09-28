#include "operation-response-v1.h"
#include "generated/macos-service-uid-v1-contract.h"

#include <stdio.h>
#include <string.h>

static void base(xpc_object_t response, const char *type, bool ok) {
    xpc_dictionary_set_string(response, "backend", RT_MACOS_SERVICE_UID_V1_CONTRACT);
    xpc_dictionary_set_uint64(response, "protocolVersion", RT_MACOS_SERVICE_UID_V1_VERSION);
    xpc_dictionary_set_string(response, "requestId", "request-prepare-1");
    xpc_dictionary_set_string(response, "serviceInstanceId", "service-1");
    xpc_dictionary_set_uint64(response, "brokerUid", 0U);
    xpc_dictionary_set_uint64(response, "executionUid", 502U);
    xpc_dictionary_set_string(response, "type", type);
    xpc_dictionary_set_bool(response, "ok", ok);
}

static void seat(xpc_object_t response, const char *state) {
    xpc_object_t value = xpc_dictionary_create(NULL, NULL, 0U);
    xpc_dictionary_set_string(value, "state", state);
    if (strcmp(state, "idle") == 0) {
        xpc_dictionary_set_value(value, "leaseId", xpc_null_create());
        xpc_dictionary_set_value(value, "executionId", xpc_null_create());
    } else {
        xpc_dictionary_set_string(value, "leaseId", "lease-1");
        xpc_dictionary_set_string(value, "executionId", "execution-1");
    }
    xpc_dictionary_set_value(response, "seat", value);
    xpc_release(value);
}

int main(void) {
    rt_service_uid_v1_request_t request = {0};
    request.type = RT_SERVICE_UID_V1_REQUEST_PREPARE;
    snprintf(request.request_id, sizeof(request.request_id), "request-prepare-1");
    xpc_object_t response = xpc_dictionary_create(NULL, NULL, 0U);
    base(response, "prepare", true);
    xpc_dictionary_set_string(response, "leaseId", "lease-1");
    xpc_dictionary_set_string(response, "executionId", "execution-1");
    xpc_dictionary_set_string(response, "preparationId", "preparation-1");
    xpc_dictionary_set_string(response, "secretChannelState", "consumed");
    seat(response, "prepared");
    bool ok = rt_service_uid_v1_parse_operation_response(response, &request);
    xpc_dictionary_set_string(response, "unexpected", "field");
    ok = ok && !rt_service_uid_v1_parse_operation_response(response, &request);
    xpc_release(response);

    request.type = RT_SERVICE_UID_V1_REQUEST_START;
    snprintf(request.request_id, sizeof(request.request_id), "request-start-1");
    response = xpc_dictionary_create(NULL, NULL, 0U);
    base(response, "start", true);
    xpc_dictionary_set_string(response, "requestId", request.request_id);
    xpc_dictionary_set_string(response, "leaseId", "lease-1");
    xpc_dictionary_set_string(response, "executionId", "execution-1");
    xpc_dictionary_set_string(response, "runId", "run-1");
    seat(response, "running");
    const bool start_ok = rt_service_uid_v1_parse_operation_response(response, &request);
    if (!start_ok) fprintf(stderr, "start response rejected\n");
    ok = ok && start_ok;
    xpc_release(response);

    request.type = RT_SERVICE_UID_V1_REQUEST_STOP;
    snprintf(request.request_id, sizeof(request.request_id), "request-stop-1");
    response = xpc_dictionary_create(NULL, NULL, 0U);
    base(response, "stop", true);
    xpc_dictionary_set_string(response, "requestId", request.request_id);
    xpc_dictionary_set_string(response, "leaseId", "lease-1");
    xpc_dictionary_set_string(response, "executionId", "execution-1");
    xpc_dictionary_set_string(response, "treeTermination", "confirmed");
    xpc_dictionary_set_string(response, "seatUidProcessState", "empty");
    seat(response, "stopped");
    const bool stop_ok = rt_service_uid_v1_parse_operation_response(response, &request);
    if (!stop_ok) fprintf(stderr, "stop response rejected\n");
    ok = ok && stop_ok;
    xpc_release(response);

    request.type = RT_SERVICE_UID_V1_REQUEST_CLEANUP;
    snprintf(request.request_id, sizeof(request.request_id), "request-cleanup-1");
    response = xpc_dictionary_create(NULL, NULL, 0U);
    base(response, "cleanup", true);
    xpc_dictionary_set_string(response, "requestId", request.request_id);
    xpc_dictionary_set_string(response, "leaseId", "lease-1");
    xpc_dictionary_set_string(response, "executionId", "execution-1");
    xpc_dictionary_set_string(response, "treeTermination", "confirmed");
    xpc_dictionary_set_string(response, "seatUidProcessState", "empty");
    xpc_dictionary_set_string(response, "secretResidue", "absent");
    seat(response, "idle");
    const bool cleanup_ok = rt_service_uid_v1_parse_operation_response(response, &request);
    if (!cleanup_ok) fprintf(stderr, "cleanup response rejected\n");
    ok = ok && cleanup_ok;
    xpc_release(response);

    request.type = RT_SERVICE_UID_V1_REQUEST_PREPARE;
    snprintf(request.request_id, sizeof(request.request_id), "request-prepare-1");
    xpc_object_t failure = xpc_dictionary_create(NULL, NULL, 0U);
    base(failure, "prepare", false);
    xpc_dictionary_set_string(failure, "error", "internal_failure");
    seat(failure, "quarantined");
    ok = ok && rt_service_uid_v1_parse_operation_response(failure, &request);
    xpc_dictionary_set_string(failure, "error", "unknown_error");
    ok = ok && !rt_service_uid_v1_parse_operation_response(failure, &request);
    xpc_release(failure);
    if (ok) puts("service-uid-v1 operation response self-test ok");
    return ok ? 0 : 1;
}
