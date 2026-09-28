#include "operation-client-v1.h"

#include "operation-response-v1.h"
#include "response-v1.h"
#include "transport-v1.h"

#include <dispatch/dispatch.h>
#include <string.h>
#include <xpc/xpc.h>

static bool request_type(xpc_object_t request, rt_service_uid_v1_request_t *parsed) {
    return request != NULL && parsed != NULL &&
        rt_service_uid_v1_parse_request(request, parsed);
}

bool rt_service_uid_v1_operation_round_trip(
    xpc_object_t request,
    const char *accepted_broker_requirement,
    int secret_fd,
    uint64_t timeout_seconds,
    uint64_t expected_broker_uid,
    uint64_t expected_execution_uid,
    xpc_object_t *response
) {
    if (response != NULL) *response = NULL;
    if (response == NULL || accepted_broker_requirement == NULL ||
        accepted_broker_requirement[0] == '\0' || timeout_seconds == 0U ||
        expected_broker_uid == UINT64_MAX || expected_execution_uid == UINT64_MAX) return false;
    rt_service_uid_v1_request_t parsed = {0};
    if (!request_type(request, &parsed)) return false;
    if (parsed.type == RT_SERVICE_UID_V1_REQUEST_STATUS ||
        (parsed.type == RT_SERVICE_UID_V1_REQUEST_PREPARE && secret_fd < 0) ||
        (parsed.type != RT_SERVICE_UID_V1_REQUEST_PREPARE && secret_fd >= 0)) return false;
    if (parsed.type == RT_SERVICE_UID_V1_REQUEST_PREPARE &&
        !rt_service_uid_v1_attach_secret_fd(request, secret_fd)) return false;

    xpc_connection_t connection = xpc_connection_create_mach_service(
        "com.roundtable.runtime.service-uid-v1", NULL,
        XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
    if (connection == NULL || xpc_connection_set_peer_code_signing_requirement(
        connection, accepted_broker_requirement) != 0) {
        if (connection != NULL) xpc_release(connection);
        return false;
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block xpc_object_t received = NULL;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY && received == NULL) {
            received = xpc_retain(event);
            dispatch_semaphore_signal(semaphore);
        }
    });
    xpc_connection_resume(connection);
    xpc_connection_send_message(connection, request);
    const uint64_t bounded_seconds = timeout_seconds > 30U ? 30U : timeout_seconds;
    const long wait_result = dispatch_semaphore_wait(
        semaphore,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)bounded_seconds * NSEC_PER_SEC));
    xpc_connection_cancel(connection);
    xpc_release(connection);
    if (wait_result != 0L || received == NULL ||
        !rt_service_uid_v1_parse_operation_response(received, &parsed) ||
        !rt_service_uid_v1_response_identity_matches(
            received, expected_broker_uid, expected_execution_uid)) {
        if (received != NULL) xpc_release(received);
        return false;
    }
    *response = received;
    return true;
}
