#include "protocol-v1.h"
#include "response-v1.h"

#include <dispatch/dispatch.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>

#ifndef RT_SERVICE_UID_V1_ACCEPTED_BROKER_REQUIREMENT
#define RT_SERVICE_UID_V1_ACCEPTED_BROKER_REQUIREMENT ""
#endif
#ifndef RT_SERVICE_UID_V1_EXPECTED_BROKER_UID
#define RT_SERVICE_UID_V1_EXPECTED_BROKER_UID UINT32_MAX
#endif
#ifndef RT_SERVICE_UID_V1_EXPECTED_EXECUTION_UID
#define RT_SERVICE_UID_V1_EXPECTED_EXECUTION_UID UINT32_MAX
#endif

int main(int argc, char **argv) {
    if (argc != 2 || RT_SERVICE_UID_V1_ACCEPTED_BROKER_REQUIREMENT[0] == '\0' ||
        RT_SERVICE_UID_V1_EXPECTED_BROKER_UID == UINT32_MAX ||
        RT_SERVICE_UID_V1_EXPECTED_EXECUTION_UID == UINT32_MAX) return 64;
    xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0U);
    if (!rt_service_uid_v1_populate_status_request(request, argv[1])) { xpc_release(request); return 64; }
    xpc_connection_t connection = xpc_connection_create_mach_service(
        "com.roundtable.runtime.service-uid-v1", NULL, XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
    if (connection == NULL) { xpc_release(request); return 70; }
    if (xpc_connection_set_peer_code_signing_requirement(connection, RT_SERVICE_UID_V1_ACCEPTED_BROKER_REQUIREMENT) != 0) {
        xpc_release(connection); xpc_release(request); return 78;
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block bool passed = false;
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
        if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) {
            passed = rt_service_uid_v1_parse_status_response(event, argv[1]);
            if (passed) passed = rt_service_uid_v1_response_identity_matches(
                event, RT_SERVICE_UID_V1_EXPECTED_BROKER_UID,
                RT_SERVICE_UID_V1_EXPECTED_EXECUTION_UID);
            dispatch_semaphore_signal(semaphore);
        }
    });
    xpc_connection_resume(connection);
    xpc_connection_send_message(connection, request);
    const long wait = dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 8LL * NSEC_PER_SEC));
    xpc_connection_cancel(connection);
    xpc_release(connection); xpc_release(request);
    return wait == 0 && passed ? 0 : 1;
}
